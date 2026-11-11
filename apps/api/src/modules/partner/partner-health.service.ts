import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { type KafkaEnvelope, type PartnerHealth, type SupervisorAlert, TOPICS } from '@yanimda/contracts';
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { OutboxBus } from '../../common/outbox';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { auditLog, partnerDelivery, partnerLatency, partnerStatus } from '../../db/schema';
import { DeviceService } from '../device/device.service';
import { loadRulePack, partnerOf, RULES, type RulesProvider, staticRules } from '../event/rules.loader';
import { PARTNER_CLOCK } from './partner-webhook.service';

/** Sıralı dizide en yakın sıra yüzdeliği (nearest-rank). */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

/** Gecikme örnekleri bu kadar gün tutulur (yönetim paneli p95, S7.3); nonce'lar imza penceresinden sonra gereksiz. */
const LATENCY_KEEP_DAYS = 7;
const NONCE_KEEP_MS = 24 * 3600_000;

/**
 * T-085 OEM ortak gecikmesi (docs/07 S2.7, S7.2). Tarama (PARTNER_SWEEP_MS, varsayılan 60 sn): ortak başına son
 * `partner.latencyWindowMin` dakikanın örneklerinden p95 / p99. En az `minSamples` örnekle p99 `latencyP99Sec`'i
 * aşarsa ortak "bozuk" (device.partner_status.degraded_since): amire O-OEM-LATENCY (bozulma başına bir, outbox →
 * supervisor.alert) ve kapsama o ortağın cihazlarını "zayıf" sayar (PARTNER_LATENCY). Yeterli örnekle p99 eşiğin altına
 * inince bozulma kapanır; örnek azsa durum değişmez. Log ve denetimde yalnız ortak kodu ve süreler.
 */
@Injectable()
export class PartnerHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PartnerHealth');
  private readonly rules: RulesProvider;
  private readonly clock: () => Date;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OutboxBus) private readonly outbox: OutboxBus,
    @Inject(DeviceService) private readonly devices: Pick<DeviceService, 'partners'>,
    @Optional() @Inject(RULES) rules?: RulesProvider,
    @Optional() @Inject(PARTNER_CLOCK) clock?: () => Date,
  ) {
    this.rules = rules ?? staticRules(loadRulePack());
    this.clock = clock ?? (() => new Date());
  }

  onModuleInit() {
    const every = Number(process.env.PARTNER_SWEEP_MS ?? 60_000);
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep().catch((e) => this.log.warn(`Tarama: ${safeError(e)}`)), every);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = this.clock()): Promise<PartnerHealth[]> {
    const p = partnerOf(this.rules.current());
    const since = new Date(now.getTime() - p.latencyWindowMin * 60_000);
    await this.db
      .delete(partnerLatency)
      .where(lt(partnerLatency.at, new Date(now.getTime() - LATENCY_KEEP_DAYS * 86_400_000)));
    await this.db
      .delete(partnerDelivery)
      .where(lt(partnerDelivery.receivedAt, new Date(now.getTime() - NONCE_KEEP_MS)));
    const out: PartnerHealth[] = [];
    for (const { partner } of this.devices.partners()) {
      const ms = (
        await this.db
          .select({ ms: partnerLatency.latencyMs })
          .from(partnerLatency)
          .where(and(eq(partnerLatency.partner, partner), gt(partnerLatency.at, since)))
          .orderBy(asc(partnerLatency.latencyMs))
      ).map((r) => r.ms);
      const p95 = percentile(ms, 95);
      const p99 = percentile(ms, 99);
      const enough = ms.length >= p.minSamples && p99 !== null;
      const over = enough && p99! > p.latencyP99Sec * 1000;
      const [prev] = await this.db.select().from(partnerStatus).where(eq(partnerStatus.partner, partner));
      const degradedSince = over ? (prev?.degradedSince ?? now) : enough ? null : (prev?.degradedSince ?? null);
      const values = { samples: ms.length, p95Ms: p95, p99Ms: p99, degradedSince, checkedAt: now };
      await this.db.transaction(async (tx) => {
        await tx
          .insert(partnerStatus)
          .values({ partner, ...values })
          .onConflictDoUpdate({ target: partnerStatus.partner, set: values });
        if (over && !prev?.degradedSince) {
          // Bozulma başladı: amire bir kez (dedupeKey bozulma başı), denetimde.
          const alert: SupervisorAlert & { dedupeKey: string } = {
            code: 'O-OEM-LATENCY',
            eventId: `partner:${partner}`,
            eventType: 'PARTNER',
            at: now.toISOString(),
            dedupeKey: `oem-latency:${partner}:${now.toISOString()}`,
          };
          await this.outbox.publish(TOPICS.supervisorAlert, this.envelope(alert, now), tx);
          await tx.insert(auditLog).values({
            actorKind: 'SYSTEM',
            action: 'partner.latency_degraded',
            entityType: 'partner',
            entityId: partner,
            data: { partner, p99Ms: p99, samples: ms.length },
          });
          this.log.warn(`${partner}: gecikme p99 ${p99} ms (${ms.length} örnek) — O-OEM-LATENCY`);
        } else if (!degradedSince && prev?.degradedSince) {
          await tx.insert(auditLog).values({
            actorKind: 'SYSTEM',
            action: 'partner.latency_recovered',
            entityType: 'partner',
            entityId: partner,
            data: { partner, p99Ms: p99, samples: ms.length },
          });
        }
      });
      out.push({
        partner,
        samples: ms.length,
        p95Ms: p95,
        p99Ms: p99,
        degradedSince: degradedSince?.toISOString() ?? null,
        checkedAt: now.toISOString(),
      });
    }
    this.outbox.notifyCommitted();
    return out;
  }

  /** GET /supervisor/partners — son taramanın sonucu (taranmamış ortak boş satır). */
  async list(): Promise<PartnerHealth[]> {
    const rows = new Map((await this.db.select().from(partnerStatus)).map((r) => [r.partner, r]));
    return this.devices.partners().map(({ partner }) => {
      const r = rows.get(partner);
      return {
        partner,
        samples: r?.samples ?? 0,
        p95Ms: r?.p95Ms ?? null,
        p99Ms: r?.p99Ms ?? null,
        degradedSince: r?.degradedSince?.toISOString() ?? null,
        checkedAt: r?.checkedAt?.toISOString() ?? null,
      };
    });
  }

  private envelope<T>(payload: T, now: Date): KafkaEnvelope<T> {
    return {
      eventId: uuidv7(),
      type: TOPICS.supervisorAlert,
      version: 1,
      occurredAt: now.toISOString(),
      countryCode: this.rules.current().country,
      subjectUserId: 'partner',
      payload,
    };
  }
}
