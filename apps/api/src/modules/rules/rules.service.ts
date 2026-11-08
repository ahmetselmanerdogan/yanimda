import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { catalogs } from '@yanimda/messages';
import Ajv2020 from 'ajv/dist/2020';
import { and, desc, eq } from 'drizzle-orm';
import YAML from 'yaml';

import { DB, type Db } from '../../db/client';
import { procedureTemplate } from '../../db/schema';
import type { RulePack, RulesProvider } from '../event/rules.loader';

export const RULES_DIR = join(__dirname, '../../../../../packages/rules');
export const RULES_OPTIONS = Symbol('RULES_OPTIONS');

export interface RulesOptions {
  dir?: string;
  country?: string;
}

/** Anahtar sırasından bağımsız içerik özeti (aynı paket = aynı checksum). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/**
 * T-012 · D-02 kural paketi yönetimi.
 * - Yükleme: packages/rules/<ülke>.yaml → JSON Schema (packages/rules/schema.json) + anlamsal kontroller
 *   (TTS kodları mesaj kataloğunda olmalı) → chain.procedure_template'e (ülke, sürüm) olarak kaydedilir.
 * - Sürüm kuralı: aynı sürüm farklı içerikle yüklenemez; daha düşük sürüm yüklenemez (409).
 * - Sıcak yükleme: POST /v1/admin/rules/reload. Diğer API örnekleri refresh() ile (periyodik) en yeni sürümü alır.
 * - Geçersiz paket geçerli paketi asla değiştirmez.
 */
@Injectable()
export class RulesService implements RulesProvider {
  private readonly log = new Logger('RulesService');
  private readonly dir: string;
  private readonly country: string;
  private readonly validateSchema;
  private pack?: RulePack;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(RULES_OPTIONS) opts: RulesOptions = {},
  ) {
    this.dir = opts.dir ?? RULES_DIR;
    this.country = (opts.country ?? process.env.COUNTRY_CODE ?? 'TR').toUpperCase();
    const ajv = new Ajv2020({ allErrors: true });
    this.validateSchema = ajv.compile(JSON.parse(readFileSync(join(RULES_DIR, 'schema.json'), 'utf8')));
  }

  current(): RulePack {
    if (!this.pack) throw new Error('Kural paketi yüklenmedi (RulesService.init çağrılmalı)');
    return this.pack;
  }

  /** Açılış: dosyayı yüklemeyi dener; olmazsa veritabanındaki en yeni geçerli sürümle devam eder. */
  async init(): Promise<void> {
    try {
      await this.reload('system:startup');
    } catch (e) {
      this.log.error(`Açılışta kural paketi yüklenemedi: ${(e as Error).message}`);
      if (!(await this.refresh())) throw e; // hiç geçerli paket yoksa açılma
    }
  }

  /** Dosyadan yükle, doğrula, sürümle kaydet, geçerli yap. */
  async reload(actor = 'admin'): Promise<{ country: string; version: number; changed: boolean }> {
    const pack = this.readAndValidate();
    const checksum = createHash('sha256').update(canonical(pack)).digest('hex');
    const changed = await this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select()
        .from(procedureTemplate)
        .where(eq(procedureTemplate.country, pack.country))
        .orderBy(desc(procedureTemplate.version))
        .limit(1)
        .for('update');
      if (latest && pack.version < latest.version)
        throw new ConflictException(
          `Sürüm ${pack.version} < yüklü sürüm ${latest.version}; geri dönüş için yeni sürüm verin`,
        );
      const [same] = await tx
        .select()
        .from(procedureTemplate)
        .where(and(eq(procedureTemplate.country, pack.country), eq(procedureTemplate.version, pack.version)));
      if (same) {
        if (same.checksum !== checksum)
          throw new ConflictException(`Sürüm ${pack.version} farklı içerikle zaten yüklü; sürümü artırın`);
        return false;
      }
      await tx
        .insert(procedureTemplate)
        .values({ country: pack.country, version: pack.version, checksum, content: pack, loadedBy: actor });
      return true;
    });
    this.pack = pack;
    if (changed) this.log.log(`Kural paketi ${pack.country} v${pack.version} yüklendi (${pack.rules.length} kural)`);
    return { country: pack.country, version: pack.version, changed };
  }

  /** Veritabanındaki en yeni sürümü al (başka örnek yüklemiş olabilir). Değiştiyse true. */
  async refresh(): Promise<boolean> {
    const [latest] = await this.db
      .select()
      .from(procedureTemplate)
      .where(eq(procedureTemplate.country, this.country))
      .orderBy(desc(procedureTemplate.version))
      .limit(1);
    if (!latest || latest.version === this.pack?.version) return false;
    this.pack = this.validate(latest.content);
    this.log.log(`Kural paketi v${latest.version} veritabanından alındı`);
    return true;
  }

  private readAndValidate(): RulePack {
    let doc: unknown;
    try {
      doc = YAML.parse(readFileSync(join(this.dir, `${this.country.toLowerCase()}.yaml`), 'utf8'));
    } catch (e) {
      throw new BadRequestException(`Kural paketi okunamadı: ${(e as Error).message}`);
    }
    const pack = this.validate(doc);
    if (pack.country.toUpperCase() !== this.country)
      throw new BadRequestException(`Paket ülkesi ${pack.country}, beklenen ${this.country}`);
    return pack;
  }

  private validate(doc: unknown): RulePack {
    if (!this.validateSchema(doc)) {
      const e = this.validateSchema.errors?.[0];
      throw new BadRequestException(`Kural paketi şemaya uymuyor: ${e?.instancePath || '/'} ${e?.message ?? ''}`);
    }
    const pack = doc as RulePack;
    const types = new Set<string>();
    for (const r of pack.rules) {
      if (types.has(r.type)) throw new BadRequestException(`Kural tekrarı: ${r.type}`);
      types.add(r.type);
      const tts = r.devicePrompt?.tts;
      if (tts && !catalogs.tr[tts]) throw new BadRequestException(`TTS kodu mesaj kataloğunda yok: ${tts}`);
    }
    return pack;
  }
}
