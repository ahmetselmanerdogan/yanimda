import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { KafkaEnvelope } from '@yanimda/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { outbox, outboxDlq } from '../db/schema';
import type { LocalBus } from './bus';
import type { OutboxBus } from './outbox';
import { safeError } from './safe-error';

export interface OutboxWorkerOptions {
  /** Yoklama aralığı (ms). Aynı süreçteki yazımlar işçiyi zaten anında uyandırır. */
  pollMs?: number;
  batchSize?: number;
  /** Bu kadar başarısız denemeden sonra satır event.outbox_dlq'ya taşınır. */
  maxAttempts?: number;
  /** n. başarısızlıktan sonra bekleme (ms). */
  backoffMs?: (attempts: number) => number;
  now?: () => Date;
  /** Kira süresi (ms): işçi ölürse başka işçi bu süreden sonra devralır. */
  leaseMs?: number;
}

/**
 * T-010 OutboxWorker: event.outbox'taki işlenmemiş satırları id sırasıyla süreç içi abonelere (LocalBus) verir.
 *
 * - Sıra: tek aktif işçi (event.outbox_lease kirası, satır başına yenilenir). Başarısız satır kuyruğun başında
 *   bekler; arkasındakiler ondan önce teslim edilmez (FALL'dan önce CANCEL işlenmesin).
 * - Yeniden deneme: üstel geri çekilme; `maxAttempts` (5) sonra outbox_dlq'ya taşınır, kuyruk ilerler.
 * - En az bir kez teslim: teslim ile işaretleme arasında süreç ölürse satır yeniden teslim edilir.
 * - Teslim transaction dışında: aboneler kendi transaction'larını açar, işçi bağlantı tutmaz (havuz 1 olsa da çalışır).
 * - Çoklu API örneğinde diğer örnekler kirayı alamaz ve beklemeye geçer; işçi ölürse kira leaseMs sonra düşer.
 *   (BullMQ zamanlayıcıları T-013'te; Kafka v2.0'da bu işçinin yerini alır.)
 */
export class OutboxWorker {
  private readonly log = new Logger('OutboxWorker');
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempts: number) => number;
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private again = false;
  private stopped = true;
  private unsubscribe?: () => void;
  private readonly leaseMs: number;
  readonly owner = `${process.pid}-${randomUUID()}`;

  constructor(
    private readonly db: Db,
    private readonly bus: LocalBus,
    private readonly outboxBus?: OutboxBus,
    opts: OutboxWorkerOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? Number(process.env.OUTBOX_POLL_MS ?? 1000);
    this.batchSize = opts.batchSize ?? 100;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffMs = opts.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, 60_000));
    this.now = opts.now ?? (() => new Date());
    this.leaseMs = opts.leaseMs ?? 30_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.outboxBus?.onCommitted(() => this.kick());
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    clearTimeout(this.timer);
  }

  /** Bekleyen bir tur yoksa hemen boşalt; tur sürüyorsa bitince bir tur daha. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) this.again = true;
    else this.schedule(0);
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    try {
      await this.drain();
    } catch (e) {
      this.log.error(`Outbox turu başarısız: ${safeError(e)}`);
    }
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      this.schedule(0);
    } else this.schedule(this.pollMs);
  }

  /** Bir veya daha çok toplu tur; teslim edilen satır sayısını döner. Eş zamanlı çağrılar aynı turu paylaşır. */
  drain(): Promise<number> {
    this.running ??= (async () => {
      try {
        if (!(await this.acquireLease())) return 0;
        try {
          let total = 0;
          for (;;) {
            const { delivered, more } = await this.drainBatch();
            total += delivered;
            if (!more) return total;
          }
        } finally {
          await this.releaseLease().catch(() => undefined);
        }
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Kirayı alır veya (kendisindeyse) yeniler. Başka canlı işçideyse false. */
  private async acquireLease(): Promise<boolean> {
    const r = (await this.db.execute(sql`
      INSERT INTO event.outbox_lease (id, owner, until)
      VALUES (1, ${this.owner}, now() + make_interval(secs => ${this.leaseMs / 1000}))
      ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, until = EXCLUDED.until
      WHERE event.outbox_lease.until < now() OR event.outbox_lease.owner = EXCLUDED.owner
      RETURNING owner`)) as unknown as { rows: unknown[] };
    return r.rows.length === 1;
  }

  private async releaseLease(): Promise<void> {
    await this.db.execute(
      sql`UPDATE event.outbox_lease SET until = '-infinity' WHERE id = 1 AND owner = ${this.owner}`,
    );
  }

  /**
   * Teslim transaction DIŞINDA yapılır: aboneler (ör. EventService) kendi transaction'larını açabilir;
   * işçi bağlantı tutmaz. Teslim ile işaretleme arasında süreç ölürse satır yeniden teslim edilir (en az bir kez).
   */
  private async drainBatch(): Promise<{ delivered: number; more: boolean }> {
    const rows = await this.db
      .select()
      .from(outbox)
      .where(isNull(outbox.processedAt))
      .orderBy(asc(outbox.id))
      .limit(this.batchSize);

    let delivered = 0;
    for (const row of rows) {
      if (!(await this.acquireLease())) return { delivered, more: false }; // kira kaybedildi (çok uzun tur)
      const now = this.now();
      if (row.nextAttemptAt > now) return { delivered, more: false }; // baştaki satır geri çekilmede: sıra korunur
      try {
        await this.bus.deliver(row.topic, row.envelope as KafkaEnvelope<unknown>);
        await this.db
          .update(outbox)
          .set({ processedAt: now })
          .where(and(eq(outbox.id, row.id), isNull(outbox.processedAt)));
        delivered++;
      } catch (e) {
        const attempts = row.attempts + 1;
        const lastError = ((e as Error).message ?? String(e)).slice(0, 1000);
        if (attempts >= this.maxAttempts) {
          await this.db.transaction(async (tx) => {
            await tx.insert(outboxDlq).values({
              id: row.id,
              topic: row.topic,
              envelope: row.envelope,
              createdAt: row.createdAt,
              failedAt: now,
              attempts,
              lastError,
            });
            await tx.delete(outbox).where(and(eq(outbox.id, row.id), isNull(outbox.processedAt)));
          });
          this.log.error(`Outbox #${row.id} (${row.topic}) ${attempts} denemede başarısız → outbox_dlq`);
          continue;
        }
        await this.db
          .update(outbox)
          .set({ attempts, lastError, nextAttemptAt: new Date(now.getTime() + this.backoffMs(attempts)) })
          .where(eq(outbox.id, row.id));
        this.log.warn(`Outbox #${row.id} (${row.topic}) teslim edilemedi, deneme ${attempts}/${this.maxAttempts}`);
        return { delivered, more: false };
      }
    }
    return { delivered, more: rows.length === this.batchSize };
  }
}
