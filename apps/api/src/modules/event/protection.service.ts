import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ProtectionState, Signal } from '@yanimda/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';

import { OutboxBus } from '../../common/outbox';
import { DB, type Db } from '../../db/client';
import { event, protectionState } from '../../db/schema';
import { CoverageService, type CoverageUpdate } from './coverage.service';
import { connectionState } from './decide';
import { DEFAULT_SLEEP_WINDOW, DEFAULT_TIMEZONE } from './night';
import type { SleepWindow } from './protection';
import { loadRulePack, RULES, type RulesProvider, staticRules } from './rules.loader';

export type { CoverageUpdate, ProtectionChange } from './coverage.service';

export interface PersonSettings extends SleepWindow {
  inactivityMin: number | null;
  learningModeUntil: Date | null;
  /** T-061: düşme sorusu cevap süresi (sn); null → kural paketi. */
  fallPromptSec: number | null;
  /** S4.10 "hastanede / seyahatte" modunun bitişi (yoksa null); bu ana kadar kapsama uyarıları durur. */
  holdUntil: Date | null;
  /** S4.10 kişiye özel kapsama boşluğu toleransı (dk; 0 = kural paketi eşikleri). */
  coverageToleranceMin: number;
}

/**
 * T-014 · D-05 koruma durumu (event.protection_state) — T-085'ten beri kapsama durumundan (CoverageService,
 * event.coverage_state) türetilir ve bir sürüm boyunca eski istemciler için yazılmaya devam eder: her değişiklik
 * aynı transaction'da outbox `user.protection.changed`. Sinyaller ve periyodik tarama kapsamayı günceller.
 * Kişi ayarları (saat dilimi, gece penceresi, eşikler) ve aile görünümü yardımcıları burada.
 */
@Injectable()
export class ProtectionService {
  private readonly rules: RulesProvider;
  /** T-085 kapsama (çoklu cihaz, şarj, kapsama yok zamanlayıcıları). */
  readonly coverage: CoverageService;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) outbox: OutboxBus,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
    this.coverage = new CoverageService(db, outbox, this.rules, this);
  }

  /** Kişinin gece penceresi: event.threshold (yoksa 22:00–08:00), kişinin saat diliminde. */
  async sleepWindowOf(protectedPersonId: string): Promise<SleepWindow> {
    const { timezone, start, end } = await this.settingsOf(protectedPersonId);
    return { timezone, start, end };
  }

  /**
   * Kişiye özel ayarlar: gece penceresi, hareketsizlik eşiği (T-070; yoksa null = kural varsayılanı), öğrenme
   * modu bitişi (profile.protected_person.learning_mode_until) ve "hastanede / seyahatte" modu bitişi (hold_until). Açık transaction içinden çağrılırken `tx` verilmeli.
   */
  async settingsOf(protectedPersonId: string, tx: Pick<Db, 'execute'> = this.db): Promise<PersonSettings> {
    const r = (await tx.execute(sql`
      SELECT p.timezone, p.learning_mode_until, p.hold_until, p.coverage_tolerance_min,
             t.sleep_start::text AS start, t.sleep_end::text AS end, t.inactivity_min, t.fall_prompt_sec
      FROM (SELECT 1) one
      LEFT JOIN profile.protected_person p ON p.id::text = ${protectedPersonId}
      LEFT JOIN event.threshold t ON t.protected_person_id = ${protectedPersonId}`)) as unknown as {
      rows: {
        timezone: string | null;
        learning_mode_until: Date | string | null;
        hold_until: Date | string | null;
        coverage_tolerance_min: number | null;
        start: string | null;
        end: string | null;
        inactivity_min: number | null;
        fall_prompt_sec: number | null;
      }[];
    };
    const row = r.rows[0];
    return {
      timezone: row?.timezone ?? DEFAULT_TIMEZONE,
      start: row?.start?.slice(0, 5) ?? DEFAULT_SLEEP_WINDOW.start,
      end: row?.end?.slice(0, 5) ?? DEFAULT_SLEEP_WINDOW.end,
      inactivityMin: row?.inactivity_min ?? null,
      learningModeUntil: row?.learning_mode_until ? new Date(row.learning_mode_until) : null,
      fallPromptSec: row?.fall_prompt_sec ?? null,
      holdUntil: row?.hold_until ? new Date(row.hold_until) : null,
      coverageToleranceMin: row?.coverage_tolerance_min ?? 0,
    };
  }

  /** T-061: aile üyesi (consumers FAMILY) bu kişiye bağlı mı. */
  async canFamilySee(subject: string, protectedPersonId: string): Promise<boolean> {
    const r = (await this.db.execute(sql`
      SELECT 1 FROM profile.family_member
      WHERE subject = ${subject} AND protected_person_id::text = ${protectedPersonId} LIMIT 1`)) as unknown as {
      rows: unknown[];
    };
    return r.rows.length > 0;
  }

  /**
   * T-061 (C-08): son konum (24 saat içindeki en yeni konumlu sinyal). Aile ayarı konum paylaşımı kapalıysa null.
   * Yalnız aile ekranı için; olay anında operatör olayın kendi konumunu görür.
   */
  async locationOf(
    protectedPersonId: string,
  ): Promise<{ lat: number; lng: number; accuracyM: number | null; at: string } | null> {
    const r = (await this.db.execute(sql`
      SELECT s.time, (s.payload->'location'->>'lat')::float8 AS lat, (s.payload->'location'->>'lng')::float8 AS lng,
             (s.payload->'location'->>'accuracyM')::float8 AS acc
      FROM signal.signal s
      WHERE s.protected_person_id = ${protectedPersonId} AND jsonb_typeof(s.payload->'location') = 'object'
        AND s.time > now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM profile.protected_person p
                        WHERE p.id::text = ${protectedPersonId} AND NOT p.location_sharing)
      ORDER BY s.time DESC LIMIT 1`)) as unknown as {
      rows: { time: Date | string; lat: number | null; lng: number | null; acc: number | null }[];
    };
    const x = r.rows[0];
    if (!x || x.lat == null || x.lng == null) return null;
    return { lat: x.lat, lng: x.lng, accuracyM: x.acc, at: new Date(x.time).toISOString() };
  }

  /** Sinyalin olgularını işler, kapsamayı (ve türetilen koruma durumunu) sinyal anına göre hesaplar. */
  applySignal(s: Signal): Promise<CoverageUpdate> {
    return this.coverage.applySignal(s);
  }

  /** Tüm kişileri `now`'a göre yeniden hesaplar (kapsama zamanlayıcıları dahil); değişenleri döner. */
  sweep(now = new Date()): Promise<CoverageUpdate[]> {
    return this.coverage.sweep(now);
  }

  /** GET /v1/protected-persons/{id}/status */
  async status(protectedPersonId: string, now = new Date()) {
    const [row] = await this.db
      .select()
      .from(protectionState)
      .where(eq(protectionState.protectedPersonId, protectedPersonId));
    if (!row) throw new NotFoundException('Kişi bulunamadı veya henüz sinyal yok');
    const pack = this.rules.current();
    const [open] = await this.db
      .select({ id: event.id, type: event.type, state: event.state, priority: event.priority })
      .from(event)
      .where(and(eq(event.protectedPersonId, protectedPersonId), ne(event.state, 'CLOSED')));
    return {
      protectedPersonId,
      state: row.state as ProtectionState,
      since: row.since.toISOString(),
      reason: row.reason,
      watch: {
        onWrist: row.watchOnWrist,
        lastSeenAt: row.watchSeenAt?.toISOString() ?? null,
        connection: connectionState(row.watchSeenAt, now, pack),
      },
      phone: {
        lastSeenAt: row.phoneSeenAt?.toISOString() ?? null,
        connection: connectionState(row.phoneSeenAt, now, pack),
      },
      sleepWindow: await this.sleepWindowOf(protectedPersonId),
      openEvent: open ?? null,
    };
  }
}
