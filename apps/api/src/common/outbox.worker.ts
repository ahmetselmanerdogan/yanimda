import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { KafkaEnvelope } from '@yanimda/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { outbox, outboxDlq, outboxSide } from '../db/schema';
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
 * İki şerit (inceleme bulgusu 3): core aboneler (olay motoru, kuyruk/aile ekranı, bildirim planı) outbox satırını
 * doğrudan alır; side aboneler (SLA metriği, faturalama, yanlış alarm kaydı) için satır işaretlenirken aynı
 * transaction'da event.outbox_side'a abone başına bir satır yazılır ve ayrı döngü (kira id = 2) teslim eder. Böylece
 * yavaş/bozuk istatistik abonesi SOS'u bekletmez; side'da hata yalnız o abonenin kuyruğunu durdurur.
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
  private sideTimer?: NodeJS.Timeout;
  private sideRunning?: Promise<number>;
  private sideAgain = false;
  private stopped = true;
  private lastErrLog = 0;
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
    this.scheduleSide(0);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    clearTimeout(this.timer);
    clearTimeout(this.sideTimer);
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

  private kickSide(): void {
    if (this.stopped) return;
    if (this.sideRunning) this.sideAgain = true;
    else this.scheduleSide(0);
  }

  private scheduleSide(ms: number) {
    clearTimeout(this.sideTimer);
    this.sideTimer = setTimeout(() => void this.sideTick(), ms);
  }

  private async sideTick() {
    try {
      await this.drainSide();
    } catch (e) {
      if (Date.now() - this.lastErrLog > 30_000) {
        this.log.error(`Outbox side turu başarısız (30 sn'de bir raporlanır): ${safeError(e)}`);
        this.lastErrLog = Date.now();
      }
    }
    if (this.stopped) return;
    if (this.sideAgain) {
      this.sideAgain = false;
      this.scheduleSide(0);
    } else this.scheduleSide(this.pollMs);
  }

  private async tick() {
    try {
      if ((await this.drainCore()) > 0) this.kickSide();
    } catch (e) {
      if (Date.now() - this.lastErrLog > 30_000) {
        this.log.error(`Outbox turu başarısız (30 sn'de bir raporlanır): ${safeError(e)}`);
        this.lastErrLog = Date.now();
      }
    }
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      this.schedule(0);
    } else this.schedule(this.pollMs);
  }

  /**
   * Testler / tek seferlik boşaltma: core ve side kuyrukları, ikisi de boşalana kadar (side abonesi yeni core satırı
   * yazabilir). Teslim edilen core satır sayısını döner. Üretimde iki döngü ayrı çalışır (start).
   */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const core = await this.drainCore();
      const side = await this.drainSide();
      total += core;
      if (!core && !side) return total;
    }
  }

  /** Core: bir veya daha çok toplu tur; teslim edilen satır sayısı. Eş zamanlı çağrılar aynı turu paylaşır. */
  drainCore(): Promise<number> {
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
  private async acquireLease(id: 1 | 2 = 1): Promise<boolean> {
    const r = (await this.db.execute(sql`
      INSERT INTO event.outbox_lease (id, owner, until)
      VALUES (${id}, ${this.owner}, now() + make_interval(secs => ${this.leaseMs / 1000}))
      ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, until = EXCLUDED.until
      WHERE event.outbox_lease.until < now() OR event.outbox_lease.owner = EXCLUDED.owner
      RETURNING owner`)) as unknown as { rows: unknown[] };
    return r.rows.length === 1;
  }

  private async releaseLease(id: 1 | 2 = 1): Promise<void> {
    await this.db.execute(
      sql`UPDATE event.outbox_lease SET until = '-infinity' WHERE id = ${id} AND owner = ${this.owner}`,
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
        await this.bus.deliver(row.topic, row.envelope as KafkaEnvelope<unknown>, 'core');
        const side = this.bus.sideNames(row.topic);
        await this.db.transaction(async (tx) => {
          const marked = await tx
            .update(outbox)
            .set({ processedAt: now })
            .where(and(eq(outbox.id, row.id), isNull(outbox.processedAt)))
            .returning({ id: outbox.id });
          if (marked.length && side.length)
            await tx
              .insert(outboxSide)
              .values(side.map((handler) => ({ outboxId: row.id, topic: row.topic, handler, envelope: row.envelope })))
              .onConflictDoNothing();
        });
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

  /** Side: abone başına sıralı teslim; teslim edilen satır sayısı. Eş zamanlı çağrılar aynı turu paylaşır. */
  drainSide(): Promise<number> {
    this.sideRunning ??= (async () => {
      try {
        if (!(await this.acquireLease(2))) return 0;
        try {
          let total = 0;
          for (;;) {
            const { delivered, more } = await this.drainSideBatch();
            total += delivered;
            if (!more) return total;
          }
        } finally {
          await this.releaseLease(2).catch(() => undefined);
        }
      } finally {
        this.sideRunning = undefined;
      }
    })();
    return this.sideRunning;
  }

  /**
   * Bekleyen side satırları id sırasıyla; bir abonenin satırı başarısız / geri çekilmedeyse o abonenin arkasındaki
   * satırları bu turda atlanır (abone başına sıra), diğer aboneler ilerler. maxAttempts sonra dead_at (abone DLQ).
   */
  private async drainSideBatch(): Promise<{ delivered: number; more: boolean }> {
    const rows = await this.db
      .select()
      .from(outboxSide)
      .where(and(isNull(outboxSide.processedAt), isNull(outboxSide.deadAt)))
      .orderBy(asc(outboxSide.id))
      .limit(this.batchSize);
    const blocked = new Set<string>();
    let delivered = 0;
    for (const row of rows) {
      if (blocked.has(row.handler)) continue;
      if (!(await this.acquireLease(2))) return { delivered, more: false };
      const now = this.now();
      if (row.nextAttemptAt > now) {
        blocked.add(row.handler);
        continue;
      }
      try {
        await this.bus.deliverSide(row.handler, row.topic, row.envelope as KafkaEnvelope<unknown>);
        await this.db.update(outboxSide).set({ processedAt: now }).where(eq(outboxSide.id, row.id));
        delivered++;
      } catch (e) {
        const attempts = row.attempts + 1;
        const lastError = ((e as Error).message ?? String(e)).slice(0, 1000);
        if (attempts >= this.maxAttempts) {
          await this.db.update(outboxSide).set({ attempts, lastError, deadAt: now }).where(eq(outboxSide.id, row.id));
          this.log.error(`Outbox side #${row.id} (${row.topic} → ${row.handler}) ${attempts} denemede başarısız → DLQ`);
          continue;
        }
        await this.db
          .update(outboxSide)
          .set({ attempts, lastError, nextAttemptAt: new Date(now.getTime() + this.backoffMs(attempts)) })
          .where(eq(outboxSide.id, row.id));
        this.log.warn(`Outbox side #${row.id} (${row.topic} → ${row.handler}) teslim edilemedi, deneme ${attempts}`);
        blocked.add(row.handler);
      }
    }
    return { delivered, more: rows.length === this.batchSize && delivered > 0 };
  }
}
