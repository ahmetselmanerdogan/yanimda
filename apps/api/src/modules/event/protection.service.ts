import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { type ProtectionState, type Signal, TOPICS } from '@yanimda/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { OutboxBus } from '../../common/outbox';
import { DB, type Db, type Tx } from '../../db/client';
import { event, protectionState } from '../../db/schema';
import { connectionState } from './decide';
import { DEFAULT_SLEEP_WINDOW, DEFAULT_TIMEZONE } from './night';
import { computeProtection, type ProtectionFacts, type SleepWindow } from './protection';
import { loadRulePack, RULES, type RulesProvider, staticRules } from './rules.loader';

export interface PersonSettings extends SleepWindow {
  inactivityMin: number | null;
  learningModeUntil: Date | null;
}

export interface ProtectionChange {
  protectedPersonId: string;
  from: ProtectionState | null;
  to: ProtectionState;
  reason: string;
  at: Date;
  facts: ProtectionFacts;
}

type Row = typeof protectionState.$inferSelect;
const maxDate = (a: Date | null, b: Date) => (a && a > b ? a : b);
const factsOf = (r?: Row): ProtectionFacts => ({
  watchOnWrist: r?.watchOnWrist ?? null,
  watchSeenAt: r?.watchSeenAt ?? null,
  phoneSeenAt: r?.phoneSeenAt ?? null,
});

/**
 * T-014 · D-05 koruma durumu (event.protection_state). Sinyallerle olgular güncellenir ve durum o sinyalin
 * anına göre hesaplanır; periyodik tarama gerçek zamana göre yeniden hesaplar (gece başlangıcı/bitişi,
 * sessizleşen cihaz). Her değişiklik aynı transaction'da outbox `user.protection.changed`.
 * Cihaz rolü sinyalin `source` alanından (T-015 adaptör). Salt okuma: profile.protected_person (saat dilimi) —
 * profile servisi (T-040) gelince oradan alınacak.
 */
@Injectable()
export class ProtectionService {
  private readonly log = new Logger('Protection');
  private readonly rules: RulesProvider;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Optional() @Inject(RULES) rules?: RulesProvider,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
  }

  /** Kişinin gece penceresi: event.threshold (yoksa 22:00–08:00), kişinin saat diliminde. */
  async sleepWindowOf(protectedPersonId: string): Promise<SleepWindow> {
    const { timezone, start, end } = await this.settingsOf(protectedPersonId);
    return { timezone, start, end };
  }

  /**
   * Kişiye özel ayarlar: gece penceresi, hareketsizlik eşiği (T-070; yoksa null = kural varsayılanı) ve öğrenme
   * modu bitişi (profile.protected_person.learning_mode_until). Açık transaction içinden çağrılırken `tx` verilmeli.
   */
  async settingsOf(protectedPersonId: string, tx: Pick<Db, 'execute'> = this.db): Promise<PersonSettings> {
    const r = (await tx.execute(sql`
      SELECT p.timezone, p.learning_mode_until,
             t.sleep_start::text AS start, t.sleep_end::text AS end, t.inactivity_min
      FROM (SELECT 1) one
      LEFT JOIN profile.protected_person p ON p.id::text = ${protectedPersonId}
      LEFT JOIN event.threshold t ON t.protected_person_id = ${protectedPersonId}`)) as unknown as {
      rows: {
        timezone: string | null;
        learning_mode_until: Date | string | null;
        start: string | null;
        end: string | null;
        inactivity_min: number | null;
      }[];
    };
    const row = r.rows[0];
    return {
      timezone: row?.timezone ?? DEFAULT_TIMEZONE,
      start: row?.start?.slice(0, 5) ?? DEFAULT_SLEEP_WINDOW.start,
      end: row?.end?.slice(0, 5) ?? DEFAULT_SLEEP_WINDOW.end,
      inactivityMin: row?.inactivity_min ?? null,
      learningModeUntil: row?.learning_mode_until ? new Date(row.learning_mode_until) : null,
    };
  }

  /** Sinyalin olgularını işler, durumu sinyal anına göre hesaplar. Durum değiştiyse değişikliği döner. */
  async applySignal(s: Signal): Promise<ProtectionChange | null> {
    // Cihaz rolü sinyal alımında adaptörden gelir (T-015); olay motoru cihaz tablosunu okumaz.
    const kind = s.source?.role ?? 'WATCH';
    const win = await this.sleepWindowOf(s.protectedPersonId);
    const at = new Date(s.occurredAt);
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, s.protectedPersonId);
      const f = factsOf(row);
      if (kind === 'PHONE') f.phoneSeenAt = maxDate(f.phoneSeenAt, at);
      else {
        if (!f.watchSeenAt || at >= f.watchSeenAt) {
          // Yalnız daha yeni sinyal bilek bilgisini değiştirir (tampondan geç gelen eskisi ezmesin).
          f.watchSeenAt = at;
          if (s.kind === 'ON_BODY') f.watchOnWrist = true;
          else if (s.kind === 'OFF_BODY') f.watchOnWrist = false;
          else if (typeof s.device?.onWrist === 'boolean') f.watchOnWrist = s.device.onWrist;
        }
        if (s.device?.connectivity === 'BLE') f.phoneSeenAt = maxDate(f.phoneSeenAt, at); // telefon köprüsü
      }
      const now = [f.watchSeenAt, f.phoneSeenAt].reduce<Date>((m, d) => maxDate(d, m) as Date, at);
      return this.save(tx, s.protectedPersonId, row, f, now, win);
    });
  }

  /** Tüm kişileri `now`'a göre yeniden hesaplar; değişenleri döner. */
  async sweep(now = new Date()): Promise<ProtectionChange[]> {
    const rows = await this.db.select().from(protectionState);
    const out: ProtectionChange[] = [];
    for (const r of rows) {
      const win = await this.sleepWindowOf(r.protectedPersonId);
      if (computeProtection(factsOf(r), now, win).state === r.state) continue;
      const change = await this.db.transaction(async (tx) => {
        const row = await this.lock(tx, r.protectedPersonId); // sinyal yarışı: kilitli yeniden hesapla
        return this.save(tx, r.protectedPersonId, row, factsOf(row), now, win);
      });
      if (change) out.push(change);
    }
    return out;
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

  private async lock(tx: Tx, protectedPersonId: string): Promise<Row | undefined> {
    const [row] = await tx
      .select()
      .from(protectionState)
      .where(eq(protectionState.protectedPersonId, protectedPersonId))
      .for('update');
    return row;
  }

  private async save(
    tx: Tx,
    protectedPersonId: string,
    row: Row | undefined,
    f: ProtectionFacts,
    now: Date,
    win: SleepWindow,
  ): Promise<ProtectionChange | null> {
    const { state, reason } = computeProtection(f, now, win);
    const changed = row?.state !== state;
    const values = {
      watchOnWrist: f.watchOnWrist,
      watchSeenAt: f.watchSeenAt,
      phoneSeenAt: f.phoneSeenAt,
      state,
      reason: changed ? reason : row!.reason,
      since: changed ? now : row!.since,
      updatedAt: new Date(),
    };
    if (row)
      await tx.update(protectionState).set(values).where(eq(protectionState.protectedPersonId, protectedPersonId));
    else await tx.insert(protectionState).values({ protectedPersonId, ...values });
    if (!changed) return null;
    const change: ProtectionChange = {
      protectedPersonId,
      from: (row?.state as ProtectionState) ?? null,
      to: state,
      reason,
      at: now,
      facts: f,
    };
    await this.outbox.publish(
      TOPICS.protectionChanged,
      {
        eventId: uuidv7(),
        type: TOPICS.protectionChanged,
        version: 1,
        occurredAt: now.toISOString(),
        countryCode: this.rules.current().country,
        subjectUserId: protectedPersonId,
        payload: { protectedPersonId, from: change.from, to: state, reason, at: now.toISOString() },
      },
      tx,
    );
    this.log.debug(`Koruma: ${change.from ?? '-'} → ${state}`);
    return change;
  }
}
