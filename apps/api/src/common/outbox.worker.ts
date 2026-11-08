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
}

const DRAIN_LOCK_KEY = 4_200_102; // tek aktif işçi (sıra garantisi) için advisory lock

/**
 * T-010 OutboxWorker: event.outbox'taki işlenmemiş satırları id sırasıyla süreç içi abonelere (LocalBus) verir.
 *
 * - Sıra: tek aktif işçi (transaction advisory lock). Başarısız satır kuyruğun başında bekler; arkasındakiler
 *   ondan önce teslim edilmez (FALL'dan önce CANCEL işlenmesin).
 * - Yeniden deneme: üstel geri çekilme; `maxAttempts` (5) sonra outbox_dlq'ya taşınır, kuyruk ilerler.
 * - En az bir kez teslim: teslim ile işaretleme arasında süreç ölürse satır yeniden teslim edilir.
 * - Çoklu API örneğinde diğer örnekler kilidi alamaz ve beklemeye geçer; gecikme ≤ pollMs.
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
        let total = 0;
        for (;;) {
          const { delivered, more } = await this.drainBatch();
          total += delivered;
          if (!more) return total;
        }
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private drainBatch(): Promise<{ delivered: number; more: boolean }> {
    return this.db.transaction(async (tx) => {
      const lock = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${DRAIN_LOCK_KEY}) AS ok`)) as unknown as {
        rows: { ok: boolean }[];
      };
      if (!lock.rows[0]?.ok) return { delivered: 0, more: false };

      const rows = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.processedAt))
        .orderBy(asc(outbox.id))
        .limit(this.batchSize)
        .for('update');

      let delivered = 0;
      for (const row of rows) {
        const now = this.now();
        if (row.nextAttemptAt > now) return { delivered, more: false }; // baştaki satır geri çekilmede: sıra korunur
        try {
          await this.bus.deliver(row.topic, row.envelope as KafkaEnvelope<unknown>);
          await tx.update(outbox).set({ processedAt: now }).where(eq(outbox.id, row.id));
          delivered++;
        } catch (e) {
          const attempts = row.attempts + 1;
          const lastError = ((e as Error).message ?? String(e)).slice(0, 1000);
          if (attempts >= this.maxAttempts) {
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
            this.log.error(`Outbox #${row.id} (${row.topic}) ${attempts} denemede başarısız → outbox_dlq`);
            continue;
          }
          await tx
            .update(outbox)
            .set({ attempts, lastError, nextAttemptAt: new Date(now.getTime() + this.backoffMs(attempts)) })
            .where(eq(outbox.id, row.id));
          this.log.warn(`Outbox #${row.id} (${row.topic}) teslim edilemedi, deneme ${attempts}/${this.maxAttempts}`);
          return { delivered, more: false };
        }
      }
      return { delivered, more: rows.length === this.batchSize };
    });
  }
}
