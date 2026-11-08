import { Logger } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { safeError } from '../safe-error';
import { assertKind, type TimerHandler, type TimerJob, timerJobId, type TimerKind, type Timers } from './timers';

export interface BullTimersOptions {
  url: string;
  /** Redis anahtar öneki (ortam/test ayrımı). */
  prefix?: string;
  queueName?: string;
  /** queue.add/remove için en fazla bekleme; aşılırsa Redis yok sayılır ve yerel yedek devreye girer. */
  addTimeoutMs?: number;
  /** Her işe ek olarak süreç içi yedek: süre + bu kadar ms sonra hâlâ çalışmadıysa yerel tetikler. */
  backupGraceMs?: number;
  attempts?: number;
  concurrency?: number;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  p.catch(() => undefined); // zaman aşımından sonra gelen ret işlenmemiş kalmasın
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Redis zaman aşımı')), ms).unref()),
  ]);
};

/**
 * T-013 BullMQ zamanlayıcıları. İş kimliği `<olayId>.<tür>` → aynı iş iki kez kurulmaz; iptal = remove.
 * İşler Redis'te kalıcıdır: süreç yeniden başlasa da süresi gelince yeni süreçte çalışır.
 *
 * Hayati olaylar için iki katmanlı güvence:
 *  1. Kurulum anında Redis yoksa → iş yerel zamanlayıcıyla aynı sürede tetiklenir.
 *  2. Kurulduktan sonra Redis çökerse → süreç içi yedek (süre + backupGraceMs) tetikler.
 *     BullMQ işi başarıyla biterse yedek iptal edilir. İşleyiciler durum kontrolüyle çift tetiklemeye dayanıklıdır.
 */
export class BullTimers implements Timers {
  private readonly log = new Logger('Timers');
  private readonly handlers = new Map<TimerKind, TimerHandler>();
  private readonly backups = new Map<string, NodeJS.Timeout>();
  private readonly queue: Queue;
  private worker?: Worker;
  private readonly conns: Redis[] = [];
  private readonly addTimeoutMs: number;
  private readonly backupGraceMs: number;
  private lastErrLog = 0;

  constructor(private readonly opts: BullTimersOptions) {
    this.addTimeoutMs = opts.addTimeoutMs ?? 2000;
    this.backupGraceMs = opts.backupGraceMs ?? 15_000;
    this.queue = new Queue(opts.queueName ?? 'timers', {
      connection: this.conn(),
      prefix: opts.prefix,
      defaultJobOptions: {
        attempts: opts.attempts ?? 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    });
    this.queue.on('error', (e) => this.logErr('kuyruk', e));
  }

  private conn(): Redis {
    const c = new Redis(this.opts.url, { maxRetriesPerRequest: null }); // BullMQ gereği
    c.on('error', (e) => this.logErr('bağlantı', e));
    this.conns.push(c);
    return c;
  }

  private logErr(where: string, e: unknown) {
    if (Date.now() - this.lastErrLog < 30_000) return;
    this.lastErrLog = Date.now();
    this.log.warn(`Redis ${where}: ${safeError(e)}`);
  }

  on(kind: TimerKind, handler: TimerHandler): void {
    this.handlers.set(kind, handler);
  }

  /** İşçiyi başlatır (işleyiciler kaydedildikten sonra). Redis yoksa arka planda bağlanmayı dener. */
  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(this.opts.queueName ?? 'timers', (job: Job<TimerJob>) => this.run(job.data), {
      connection: this.conn(),
      prefix: this.opts.prefix,
      concurrency: this.opts.concurrency ?? 10,
    });
    this.worker.on('error', (e) => this.logErr('işçi', e));
    this.worker.on('completed', (job) => this.clearBackup(job.id!));
    this.worker.on('failed', (job, e) =>
      this.log.warn(`Zamanlayıcı ${job?.name} başarısız (deneme ${job?.attemptsMade}): ${safeError(e)}`),
    );
  }

  async schedule(eventId: string, kind: TimerKind, delayMs: number, data?: Record<string, unknown>): Promise<void> {
    assertKind(kind);
    const id = timerJobId(eventId, kind);
    const job: TimerJob = { eventId, kind, ...(data ? { data } : {}) };
    const t0 = Date.now();
    try {
      await withTimeout(this.add(id, job, delayMs), this.addTimeoutMs);
      if (!this.backups.has(id)) this.setBackup(id, job, delayMs + this.backupGraceMs);
    } catch (e) {
      this.log.error(`Zamanlayıcı Redis'e yazılamadı (${kind}), yerel yedek kuruldu: ${safeError(e)}`);
      this.clearBackup(id);
      this.setBackup(id, job, Math.max(0, delayMs - (Date.now() - t0)));
    }
  }

  private async add(id: string, job: TimerJob, delayMs: number) {
    // Tamamlanmış/başarısız eski iş aynı kimliği tutuyorsa yenisi kurulamaz → önce temizle.
    const old = await this.queue.getJob(id);
    if (old && ['completed', 'failed'].includes(await old.getState())) await old.remove();
    await this.queue.add(job.kind, job, { jobId: id, delay: Math.max(0, Math.round(delayMs)) });
  }

  async cancel(eventId: string, kind: TimerKind): Promise<void> {
    const id = timerJobId(eventId, kind);
    this.clearBackup(id);
    try {
      const job = await withTimeout(this.queue.getJob(id), this.addTimeoutMs);
      await job?.remove();
    } catch (e) {
      // Çalışmakta olan iş silinemez veya Redis yok: işleyici durum kontrolüyle no-op olur.
      this.log.warn(`Zamanlayıcı iptal edilemedi (${kind}): ${safeError(e)}`);
    }
  }

  /** Bekleyen iş kimlikleri (gözlem/test). */
  async pending(): Promise<string[]> {
    const jobs = await this.queue.getJobs(['delayed', 'waiting', 'prioritized']);
    return jobs.map((j) => j.id!).filter(Boolean);
  }

  async close(): Promise<void> {
    for (const t of this.backups.values()) clearTimeout(t);
    this.backups.clear();
    await this.worker?.close().catch(() => undefined);
    await this.queue.close().catch(() => undefined);
    for (const c of this.conns) c.disconnect();
  }

  private setBackup(id: string, job: TimerJob, ms: number) {
    this.backups.set(
      id,
      setTimeout(() => {
        this.backups.delete(id);
        this.log.warn(`Zamanlayıcı yerel yedekten tetiklendi (${job.kind})`);
        this.run(job).catch((e) => this.log.error(`Yedek zamanlayıcı işleyicisi başarısız: ${safeError(e)}`));
      }, ms),
    );
  }

  private clearBackup(id: string) {
    clearTimeout(this.backups.get(id));
    this.backups.delete(id);
  }

  private async run(job: TimerJob): Promise<void> {
    const h = this.handlers.get(job.kind);
    if (!h) throw new Error(`İşleyici yok: ${job.kind}`);
    await h(job);
  }
}
