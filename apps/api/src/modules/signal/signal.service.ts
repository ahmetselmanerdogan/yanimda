import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type KafkaEnvelope, type Signal, TOPICS } from '@yanimda/contracts';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { device, signal } from '../../db/schema';
import { DeviceService } from '../device/device.service';
import { IdempotencyStore } from './idempotency.store';
import { AUTH_REJECT_REASONS, rejectedEntry, type RejectedSignal, type SignalRejectReason } from './signal-reject';

export interface AcceptResult {
  accepted: number;
  duplicates: number;
  /** Reddedilen sinyaller (partideki sıra + sabit kod). Cihaz yalnız bunları kalıcı hata sayar. */
  rejected: RejectedSignal[];
}

/** Log için: neden → adet (PII yok). */
function summary(rs: RejectedSignal[]): string {
  const m = new Map<string, number>();
  for (const r of rs) m.set(r.reason, (m.get(r.reason) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k}=${n}`).join(', ');
}

/**
 * D-01 Sinyal alımı (T-010): şema doğrulama → Redis idempotency → TEK transaction:
 * signal.signal + event.outbox (signal.received) + cihaz durumu. Teslimat OutboxWorker'dadır.
 *
 * Sinyal başına kabul: şemaya uymayan, cihaz türünün desteklemediği veya token yetkisi dışındaki sinyal yalnız
 * kendisi reddedilir (`rejected`); partinin geri kalanı yazılır — SOS, yanındaki geçersiz/desteklenmeyen sinyal
 * veya iptal edilmiş saatin sinyali yüzünden kaybolmaz. Yazılabilecek tek sinyal yoksa 400 (yetki retti varsa
 * 403), Problem gövdesinde `rejected`.
 * Parti sırayla işlenir (sinyal sırası korunur). Herhangi bir yazım hatası 503 döner; cihaz partiyi yeniden
 * gönderir, önceden yazılanlar duplicate sayılır (kayıp yok, çift yok). Log'larda PII yok: yalnız kind/sayı.
 */
@Injectable()
export class SignalService {
  private readonly log = new Logger('SignalService');
  private readonly validate;
  private readonly country = process.env.COUNTRY_CODE ?? 'TR';

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(IdempotencyStore) private readonly idem: IdempotencyStore,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(DeviceService) private readonly devices: DeviceService,
  ) {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const schemaPath = join(__dirname, '../../../../../packages/contracts/schemas/signal.schema.json');
    this.validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  }

  /**
   * @param denied Yetki denetiminin (CompanionService.authorizeBatch) reddettiği sıralar → neden.
   */
  async accept(batch: unknown[], denied: ReadonlyMap<number, SignalRejectReason> = new Map()): Promise<AcceptResult> {
    if (!Array.isArray(batch) || batch.length === 0) throw new BadRequestException('Boş sinyal listesi');
    const rejected: RejectedSignal[] = [];
    const candidates: { index: number; signal: Signal }[] = [];
    batch.forEach((raw, index) => {
      const deny = denied.get(index);
      if (deny) rejected.push(rejectedEntry(index, raw, deny));
      else if (!this.validate(raw)) rejected.push(rejectedEntry(index, raw, 'SCHEMA_INVALID'));
      else candidates.push({ index, signal: raw as Signal });
    });

    // T-015: her sinyal cihaz türünün adaptöründen geçer (normalize + source). Desteklenmeyen → yalnız o sinyal.
    const prepared: Signal[] = [];
    const normalized = candidates.length ? await this.devices.prepareEach(candidates.map((c) => c.signal)) : [];
    normalized.forEach((s, i) => {
      if (s) prepared.push(s);
      else rejected.push(rejectedEntry(candidates[i].index, candidates[i].signal, 'UNSUPPORTED_SIGNAL'));
    });
    rejected.sort((a, b) => a.index - b.index);
    if (rejected.length)
      this.log.warn(`Partide ${rejected.length}/${batch.length} sinyal reddedildi (${summary(rejected)})`);
    if (!prepared.length) {
      const body = { message: 'Partide kabul edilebilir sinyal yok', rejected };
      throw rejected.some((r) => AUTH_REJECT_REASONS.has(r.reason))
        ? new ForbiddenException(body)
        : new BadRequestException(body);
    }

    let accepted = 0;
    let duplicates = 0;
    for (const raw of prepared) {
      const s: Signal = { ...raw, receivedAt: new Date().toISOString() };
      const claim = await this.idem.claim(s.idempotencyKey);
      if (claim === 'duplicate') {
        duplicates++;
        continue;
      }
      if (claim === 'pending') {
        // Aynı sinyal şu an başka bir istekte yazılıyor; sonucu belli değil → cihaz yeniden denesin.
        if (accepted) this.outbox.notifyCommitted();
        throw new ServiceUnavailableException('Sinyal işleniyor, yeniden deneyin');
      }

      let inserted: boolean;
      try {
        inserted = await this.db.transaction((tx) => this.persist(tx, s));
      } catch (e) {
        await this.idem.release(s.idempotencyKey);
        this.log.error(`Sinyal yazılamadı (kind=${s.kind}): ${safeError(e)}`);
        if (accepted) this.outbox.notifyCommitted();
        throw new ServiceUnavailableException('Sinyal kaydedilemedi, yeniden deneyin');
      }
      await this.idem.complete(s.idempotencyKey);
      if (inserted) accepted++;
      else duplicates++;
    }
    if (accepted) this.outbox.notifyCommitted();
    return { accepted, duplicates, rejected };
  }

  /** Tek transaction. Veritabanında zaten varsa (Redis anahtarı kaybolmuşsa) false döner, outbox'a yazmaz. */
  private async persist(tx: Tx, s: Signal): Promise<boolean> {
    const occurredAt = new Date(s.occurredAt);
    const rows = await tx
      .insert(signal)
      .values({
        time: occurredAt,
        deviceId: s.deviceId,
        protectedPersonId: s.protectedPersonId,
        kind: s.kind,
        value: s.value ?? null,
        payload: s,
        idempotencyKey: s.idempotencyKey,
        receivedAt: new Date(s.receivedAt!),
      })
      .onConflictDoNothing({ target: [signal.idempotencyKey, signal.time] })
      .returning({ key: signal.idempotencyKey });
    if (rows.length === 0) return false;

    const envelope: KafkaEnvelope<Signal> = {
      eventId: uuidv7(),
      type: TOPICS.signalReceived,
      version: 1,
      occurredAt: s.occurredAt,
      countryCode: this.country,
      subjectUserId: s.protectedPersonId,
      payload: s,
    };
    await this.outbox.publish(TOPICS.signalReceived, envelope, tx);

    // Cihaz durumu (T-010 adım 6). Geçici olarak burada: device modülü (T-041) gelince onun servisine taşınır.
    // Tamponlanıp geç gelen eski sinyal yeni durumu ezmesin diye yalnız daha yeni occurredAt yazılır.
    const battery = s.device?.batteryPct ?? (s.kind === 'BATTERY' && s.value != null ? Math.round(s.value) : null);
    const onWrist = s.device?.onWrist ?? (s.kind === 'ON_BODY' ? true : s.kind === 'OFF_BODY' ? false : null);
    // T-086: şarj (CHARGE_START/END veya cihaz bloğundaki charging). Takılan cihaz şarjda değildir.
    const charging =
      s.kind === 'CHARGE_START'
        ? true
        : s.kind === 'CHARGE_END' || onWrist === true
          ? false
          : (s.device?.charging ?? null);
    await tx
      .update(device)
      .set({
        lastSeenAt: occurredAt,
        batteryPct: battery ?? sql`${device.batteryPct}`,
        onWrist: (charging === true ? false : onWrist) ?? sql`${device.onWrist}`,
        connectivity: s.device?.connectivity ?? sql`${device.connectivity}`,
        charging: charging ?? sql`${device.charging}`,
        chargingSince:
          charging === true
            ? sql`CASE WHEN ${device.charging} THEN coalesce(${device.chargingSince}, ${occurredAt.toISOString()}::timestamptz)
                ELSE ${occurredAt.toISOString()}::timestamptz END`
            : charging === false
              ? null
              : sql`${device.chargingSince}`,
      })
      .where(
        and(eq(sql`${device.id}::text`, s.deviceId), or(isNull(device.lastSeenAt), lte(device.lastSeenAt, occurredAt))),
      );
    return true;
  }
}
