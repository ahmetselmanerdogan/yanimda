import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type KafkaEnvelope, type NotifyRequest, type Signal, TOPICS, type WorkOrder } from '@yanimda/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db, type Tx } from '../../db/client';
import { auditLog, pendantMaintenance, workOrder } from '../../db/schema';
import { profileOf } from '../event/coverage';
import {
  isLongLifeBattery,
  loadRulePack,
  pendantOf,
  type PendantParams,
  RULES,
  type RulesProvider,
  staticRules,
} from '../event/rules.loader';
import { PARTNER_CLOCK } from './partner-webhook.service';

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Pil bu kadar puan birden yükselirse pil değişmiş sayılır (eğilim sıfırlanır). */
const REPLACED_JUMP_PCT = 20;
/** Gözlenen tüketim hızı en az bu kadar günlük eğilimden hesaplanır (tek haftalık gürültü tahmini bozmasın). */
const MIN_TREND_DAYS = 7;

/**
 * Tahmini bitişe kalan gün (S4.9): katalog pil ömrüyle (pil % × ömür) ve eğilim yeterince uzunsa gözlenen tüketim
 * hızıyla; ikisinden erken olan. Bilinmiyorsa null.
 */
export function predictedDaysLeft(
  pct: number,
  at: Date,
  batteryLifeH: number | null | undefined,
  baseline?: { pct: number | null; at: Date | null } | null,
): number | null {
  const nominal = batteryLifeH ? ((pct / 100) * batteryLifeH) / 24 : null;
  let observed: number | null = null;
  if (baseline?.pct != null && baseline.at) {
    const days = (at.getTime() - baseline.at.getTime()) / DAY;
    const used = baseline.pct - pct;
    if (days >= MIN_TREND_DAYS && used > 0) observed = pct / (used / days);
  }
  const xs = [nominal, observed].filter((x): x is number => x !== null);
  return xs.length ? Math.min(...xs) : null;
}

/** İş emri gerekiyor mu (yoksa null): %workOrderPct altı veya tahmini bitime workOrderDaysBeforeEnd gün kaldı. */
export function workOrderReason(
  pct: number,
  daysLeft: number | null,
  p: Pick<PendantParams, 'workOrderPct' | 'workOrderDaysBeforeEnd'>,
): WorkOrder['reason'] | null {
  if (pct < p.workOrderPct) return 'LOW_BATTERY';
  if (daysLeft !== null && daysLeft <= p.workOrderDaysBeforeEnd) return 'PREDICTED_END';
  return null;
}

type Row = typeof workOrder.$inferSelect;
const view = (r: Row): WorkOrder => ({
  id: r.id,
  kind: r.kind as WorkOrder['kind'],
  status: r.status as WorkOrder['status'],
  reason: r.reason as WorkOrder['reason'],
  deviceId: r.deviceId,
  protectedPersonId: r.protectedPersonId,
  batteryPct: r.batteryPct,
  predictedEndAt: r.predictedEndAt?.toISOString() ?? null,
  dueAt: r.dueAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
  closedAt: r.closedAt?.toISOString() ?? null,
});

/**
 * T-085 / T-086 12 ay pilli kolye bakımı (docs/07 S4.9). Yaşlı hiç rahatsız edilmez (olay motoru uzun ömürlü pilde
 * W-BAT-* göndermez). Burada:
 *  - Pil raporu (BATTERY; ortak haftalık gönderir): %workOrderPct altı veya tahmini bitime workOrderDaysBeforeEnd gün
 *    kaldıysa operasyon iş emri (replaceWithinDays gün içinde yerinde değişim; cihaz başına tek açık) + aileye
 *    F-PENDANT-BATTERY (aynı transaction'da outbox). Pil replacedPct ve üstüne çıkınca açık iş emri kapanır (REPLACED).
 *  - Aylık test hatırlatması (tarama): testReminderDays gündür düğme testi (TEST sinyali) yoksa yaşlının telefonuna
 *    P-PENDANT-TEST ve aileye F-PENDANT-TEST; ayda bir. "Hastanede / seyahatte" modunda gönderilmez.
 * Sinyaller outbox'tan side şeridinde gelir (SOS'u bekletmez, en az bir kez; işlem idempotent). Log'da kimlik yok.
 */
@Injectable()
export class PendantMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PendantMaintenance');
  private readonly rules: RulesProvider;
  private readonly clock: () => Date;
  private unsub?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Optional() @Inject(RULES) rules?: RulesProvider,
    @Optional() @Inject(PARTNER_CLOCK) clock?: () => Date,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
    this.clock = clock ?? (() => new Date());
  }

  onModuleInit() {
    this.subscribe();
    const every = Number(process.env.MAINTENANCE_SWEEP_MS ?? 3_600_000);
    if (every > 0) {
      this.timer = setInterval(
        () => void this.remindTests().catch((e) => this.log.warn(`Test hatırlatma taraması: ${safeError(e)}`)),
        every,
      );
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    this.unsub?.();
    if (this.timer) clearInterval(this.timer);
  }

  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<Signal>(TOPICS.signalReceived, (e) => this.onSignal(e.payload), {
      lane: 'side',
      name: 'pendant.maintenance',
    });
  }

  private get params() {
    return pendantOf(this.rules.current());
  }

  async onSignal(s: Signal): Promise<void> {
    if (s.kind !== 'BATTERY' || typeof s.value !== 'number') return;
    if (!isLongLifeBattery(this.rules.current(), s.source?.batteryLifeH) || profileOf(s.source).tier !== 'A') return;
    if (!UUID.test(s.deviceId) || !UUID.test(s.protectedPersonId)) return; // kayıtlı cihaz (iş emri cihaz satırına bağlı)
    await this.onBattery(s, Math.round(s.value), new Date(s.occurredAt));
  }

  private async onBattery(s: Signal, pct: number, at: Date) {
    const p = this.params;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(pendantMaintenance)
        .values({ deviceId: s.deviceId, protectedPersonId: s.protectedPersonId })
        .onConflictDoNothing();
      const [m] = await tx
        .select()
        .from(pendantMaintenance)
        .where(eq(pendantMaintenance.deviceId, s.deviceId))
        .for('update');
      if (m?.lastAt && at < m.lastAt) return; // eski rapor (tampondan geç geldi)
      const replaced = m?.lastPct != null && pct >= m.lastPct + REPLACED_JUMP_PCT;
      const baseline = !m?.baselineAt || replaced ? { pct, at } : { pct: m.baselinePct, at: m.baselineAt };
      await tx
        .update(pendantMaintenance)
        .set({ baselinePct: baseline.pct, baselineAt: baseline.at, lastPct: pct, lastAt: at })
        .where(eq(pendantMaintenance.deviceId, s.deviceId));

      if (pct >= p.replacedPct) {
        const closed = await tx
          .update(workOrder)
          .set({ status: 'DONE', closedAt: at, closedBy: 'SYSTEM', closeReason: 'REPLACED' })
          .where(
            and(
              eq(workOrder.deviceId, s.deviceId),
              eq(workOrder.kind, 'PENDANT_BATTERY'),
              eq(workOrder.status, 'OPEN'),
            ),
          )
          .returning({ id: workOrder.id });
        for (const c of closed) await this.audit(tx, 'work_order.closed', c.id, { reason: 'REPLACED', pct });
        return;
      }

      const daysLeft = predictedDaysLeft(pct, at, s.source?.batteryLifeH, baseline);
      const reason = workOrderReason(pct, daysLeft, p);
      if (!reason) return;
      const id = uuidv7();
      const inserted = await tx
        .insert(workOrder)
        .values({
          id,
          kind: 'PENDANT_BATTERY',
          reason,
          deviceId: s.deviceId,
          protectedPersonId: s.protectedPersonId,
          batteryPct: pct,
          predictedEndAt: daysLeft !== null ? new Date(at.getTime() + daysLeft * DAY) : null,
          dueAt: new Date(at.getTime() + p.replaceWithinDays * DAY),
          createdAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: workOrder.id });
      if (!inserted.length) return; // cihazın açık iş emri var
      await this.audit(tx, 'work_order.opened', id, { kind: 'PENDANT_BATTERY', reason, pct });
      await this.notify(tx, {
        code: 'F-PENDANT-BATTERY',
        audience: 'FAMILY',
        protectedPersonId: s.protectedPersonId,
        dedupeKey: `pendant-battery:${id}`,
        vars: { pct, days: p.replaceWithinDays },
      });
      this.log.log(`Kolye pili iş emri açıldı (${reason})`);
    });
    this.outbox.notifyCommitted();
  }

  /**
   * Aylık test hatırlatması (S4.9, EN 50134 aylık uçtan uca test): uzun ömürlü pilli, etkin A sınıfı cihazlarda son
   * düğme testi (TEST sinyali; yoksa kayıt anı) testReminderDays'ten eskiyse ve son hatırlatma da o kadar eskiyse.
   * Gönderilen hatırlatma sayısını döner.
   */
  async remindTests(now = this.clock()): Promise<number> {
    const p = this.params;
    const cutoff = new Date(now.getTime() - p.testReminderDays * DAY).toISOString();
    const r = (await this.db.execute(sql`
      SELECT d.id::text AS device_id, d.protected_person_id::text AS person_id
      FROM device.device d
      JOIN device.device_model m ON m.id = coalesce(d.model_id, d.kind)
      LEFT JOIN device.pendant_maintenance pm ON pm.device_id = d.id
      LEFT JOIN profile.protected_person pp ON pp.id = d.protected_person_id
      WHERE d.revoked_at IS NULL AND d.retired_at IS NULL
        AND m.battery_life_h >= ${p.longLifeBatteryH} AND coalesce(d.tier, m.tier) = 'A'
        AND coalesce((SELECT max(s.time) FROM signal.signal s WHERE s.device_id = d.id::text AND s.kind = 'TEST'),
                     d.enrolled_at, d.created_at) <= ${cutoff}::timestamptz
        AND (pm.test_reminded_at IS NULL OR pm.test_reminded_at <= ${cutoff}::timestamptz)
        AND (pp.hold_until IS NULL OR pp.hold_until <= ${now.toISOString()}::timestamptz)`)) as unknown as {
      rows: { device_id: string; person_id: string }[];
    };
    for (const x of r.rows) {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(pendantMaintenance)
          .values({ deviceId: x.device_id, protectedPersonId: x.person_id, testRemindedAt: now })
          .onConflictDoUpdate({ target: pendantMaintenance.deviceId, set: { testRemindedAt: now } });
        const dedupeKey = `pendant-test:${x.device_id}:${now.toISOString().slice(0, 10)}`;
        for (const [code, audience] of [
          ['P-PENDANT-TEST', 'ELDER'],
          ['F-PENDANT-TEST', 'FAMILY'],
        ] as const)
          await this.notify(tx, { code, audience, protectedPersonId: x.person_id, dedupeKey });
      });
    }
    if (r.rows.length) {
      this.outbox.notifyCommitted();
      this.log.log(`${r.rows.length} kolye için aylık test hatırlatması`);
    }
    return r.rows.length;
  }

  // ---- İş emirleri (amir) ----

  async list(opts: { status?: string } = {}): Promise<WorkOrder[]> {
    const status = opts.status === 'DONE' || opts.status === 'OPEN' ? opts.status : undefined;
    const rows = await this.db
      .select()
      .from(workOrder)
      .where(status ? eq(workOrder.status, status) : undefined)
      .orderBy(asc(workOrder.dueAt))
      .limit(500);
    return rows.map(view);
  }

  /** Amir "tamamlandı" (yerinde değişim yapıldı): kim, ne zaman; denetimde. Zaten kapalıysa 409. */
  async done(id: string, by: string, now = this.clock()): Promise<WorkOrder> {
    if (!UUID.test(id)) throw new NotFoundException('İş emri yok');
    const row = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .update(workOrder)
        .set({ status: 'DONE', closedAt: now, closedBy: by, closeReason: 'DONE' })
        .where(and(eq(workOrder.id, id), eq(workOrder.status, 'OPEN')))
        .returning();
      if (r) await this.audit(tx, 'work_order.closed', id, { reason: 'DONE' }, by);
      return r;
    });
    if (row) return view(row);
    const [exists] = await this.db.select({ id: workOrder.id }).from(workOrder).where(eq(workOrder.id, id));
    throw exists ? new ConflictException('İş emri zaten kapalı') : new NotFoundException('İş emri yok');
  }

  private async audit(tx: Tx, action: string, id: string, data: Record<string, unknown>, by?: string) {
    await tx.insert(auditLog).values({
      actorKind: by ? 'OPERATOR' : 'SYSTEM',
      actorId: by ?? null,
      action,
      entityType: 'work_order',
      entityId: id,
      data,
    });
  }

  private async notify(tx: Tx, req: NotifyRequest) {
    const env: KafkaEnvelope<NotifyRequest> = {
      eventId: uuidv7(),
      type: TOPICS.notifyRequested,
      version: 1,
      occurredAt: this.clock().toISOString(),
      countryCode: this.rules.current().country,
      subjectUserId: req.protectedPersonId,
      payload: { ...req, dedupeKey: `${req.dedupeKey}:${req.code}` },
    };
    await this.outbox.publish(TOPICS.notifyRequested, env, tx);
  }
}
