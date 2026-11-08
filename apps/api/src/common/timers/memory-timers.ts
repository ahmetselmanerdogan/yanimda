import { assertKind, type TimerHandler, type TimerJob, timerJobId, type TimerKind, type Timers } from './timers';

/** Süreç içi zamanlayıcı (setTimeout). Yalnız testler içindir: yeniden başlatmada işler kaybolur. */
export class InMemoryTimers implements Timers {
  private readonly handlers = new Map<TimerKind, TimerHandler>();
  private readonly jobs = new Map<string, { job: TimerJob; delayMs: number; t: NodeJS.Timeout }>();

  on(kind: TimerKind, handler: TimerHandler): void {
    this.handlers.set(kind, handler);
  }

  async schedule(eventId: string, kind: TimerKind, delayMs: number, data?: Record<string, unknown>): Promise<void> {
    assertKind(kind);
    const id = timerJobId(eventId, kind);
    if (this.jobs.has(id)) return;
    const job: TimerJob = { eventId, kind, ...(data ? { data } : {}) };
    const t = setTimeout(() => {
      this.jobs.delete(id);
      void this.run(job);
    }, delayMs);
    this.jobs.set(id, { job, delayMs, t });
  }

  async cancel(eventId: string, kind: TimerKind): Promise<void> {
    const id = timerJobId(eventId, kind);
    clearTimeout(this.jobs.get(id)?.t);
    this.jobs.delete(id);
  }

  /** Test: işi süresini beklemeden çalıştır (bekleyen yoksa da çalıştırır: geç gelen/çift teslim benzetimi). */
  async fire(eventId: string, kind: TimerKind): Promise<void> {
    await this.cancel(eventId, kind);
    await this.run({ eventId, kind });
  }

  pendingIds(): string[] {
    return [...this.jobs.keys()];
  }

  delayOf(id: string): number | undefined {
    return this.jobs.get(id)?.delayMs;
  }

  private async run(job: TimerJob) {
    await this.handlers.get(job.kind)?.(job);
  }
}
