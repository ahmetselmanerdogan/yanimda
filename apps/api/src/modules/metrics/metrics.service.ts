import { createServer, type Server } from 'node:http';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type EventState, TOPICS } from '@yanimda/contracts';
import { sql } from 'drizzle-orm';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

import { bus as globalBus, type LocalBus } from '../../common/bus';
import { safeError } from '../../common/safe-error';
import { DB, type Db } from '../../db/client';
import { EventService } from '../event/event.service';
import { falseAlarmStats } from '../false-alarm/stats';

const BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600];
const CONFIRMED: EventState[] = ['CONFIRMED_OK', 'CONFIRMED_EMERGENCY'];

interface Transition {
  eventId: string;
  from?: EventState;
  to: EventState;
}

type Rows<T> = { rows: T[] };

/**
 * T-025 (E-09, D-11) SLA metrikleri (Prometheus). Geçişler outbox → bus ile tek işçide bir kez gelir:
 *  - signal_to_screen_seconds: olay kuyruğa düşüp konsola yayınlanana kadar; cihaz sorusu olmayan olayda başlangıç
 *    ilk sinyalin alınışı, sorulu olayda yükseltme anı (sorunun bekleme süresi SLA dışıdır)
 *  - operator_claim_seconds: kuyruğa düşüş → üstlenme (hedef 10 sn)
 *  - event_decision_seconds: kuyruğa düşüş → teyit (CONFIRMED_OK / CONFIRMED_EMERGENCY)
 *  - queue_depth (öncelik), false_alarm_ratio (son 24 saat), false_alarm_ratio_30d (T-071): her okumada veritabanından
 * /metrics iç ağda ayrı portta (METRICS_PORT); genel API'den yayınlanmaz.
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Metrics');
  readonly registry = new Registry();
  readonly signalToScreen: Histogram<'priority'>;
  readonly claim: Histogram<'priority'>;
  readonly decision: Histogram<'priority' | 'outcome'>;
  private unsub?: () => void;
  private server?: Server;
  /** Outbox en az bir kez teslim eder: aynı geçiş (olay + hedef durum + kaçıncı kez) bir kez ölçülür. */
  private readonly seen = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EventService) private readonly events: EventService,
  ) {
    const registers = [this.registry];
    this.signalToScreen = new Histogram({
      name: 'signal_to_screen_seconds',
      help: 'Sinyal (veya yükseltme) → operatör ekranına yayın',
      labelNames: ['priority'],
      buckets: BUCKETS,
      registers,
    });
    this.claim = new Histogram({
      name: 'operator_claim_seconds',
      help: 'Kuyruğa düşüş → üstlenme',
      labelNames: ['priority'],
      buckets: BUCKETS,
      registers,
    });
    this.decision = new Histogram({
      name: 'event_decision_seconds',
      help: 'Kuyruğa düşüş → teyit (iyi / acil)',
      labelNames: ['priority', 'outcome'],
      buckets: BUCKETS,
      registers,
    });
    const store = this.db;
    new Gauge({
      name: 'queue_depth',
      help: 'Bekleyen (üstlenilmemiş) olay sayısı',
      labelNames: ['priority'],
      registers,
      async collect() {
        this.reset();
        const r = (await store.execute(sql`
          SELECT priority, count(*)::int AS n FROM event.event WHERE state = 'OPERATOR_QUEUE' GROUP BY priority`)) as unknown as Rows<{
          priority: number;
          n: number;
        }>;
        for (const p of [1, 2, 3, 4]) this.set({ priority: String(p) }, r.rows.find((x) => x.priority === p)?.n ?? 0);
      },
    });
    new Gauge({
      name: 'false_alarm_ratio',
      help: 'Son 24 saatte kapanan olaylarda yanlış alarm oranı (test olayları hariç)',
      registers,
      async collect() {
        const r = (await store.execute(sql`
          SELECT count(*) FILTER (WHERE confirmed_outcome = 'FALSE_ALARM')::int AS f, count(*)::int AS n
          FROM event.event WHERE closed_at > now() - interval '24 hours' AND NOT is_test`)) as unknown as Rows<{
          f: number;
          n: number;
        }>;
        const row = r.rows[0];
        this.set(row && row.n ? row.f / row.n : 0);
      },
    });
    new Gauge({
      name: 'false_alarm_ratio_30d',
      help: 'T-071: son 30 günde yanlış alarm kaydı / kapanan olay (test hariç; aile geri bildirimi dahil)',
      registers,
      async collect() {
        this.set((await falseAlarmStats(store, new Date(), 30, 3)).ratio);
      },
    });
    // İnceleme bulgusu 3: outbox şeritleri izlenir (birikme, en eski bekleyen, DLQ). Uyarı kuralları infra/prometheus.
    // prom-client metrikleri paralel toplar: her gauge kendi sorgusunu yapar.
    const lanes = async () =>
      (
        (await store.execute(sql`
          SELECT 'core' AS lane, count(*)::int AS n, coalesce(extract(epoch FROM now() - min(created_at)), 0)::float AS age
            FROM event.outbox WHERE processed_at IS NULL
          UNION ALL
          SELECT 'side', count(*)::int, coalesce(extract(epoch FROM now() - min(created_at)), 0)::float
            FROM event.outbox_side WHERE processed_at IS NULL AND dead_at IS NULL`)) as unknown as Rows<{
          lane: string;
          n: number;
          age: number;
        }>
      ).rows;
    new Gauge({
      name: 'outbox_pending',
      help: 'Teslim bekleyen outbox satırı (core: event.outbox, side: event.outbox_side)',
      labelNames: ['lane'],
      registers,
      async collect() {
        for (const row of await lanes()) this.set({ lane: row.lane }, row.n);
      },
    });
    new Gauge({
      name: 'outbox_oldest_pending_seconds',
      help: 'En eski teslim edilmemiş outbox satırının yaşı',
      labelNames: ['lane'],
      registers,
      async collect() {
        for (const row of await lanes()) this.set({ lane: row.lane }, row.age);
      },
    });
    new Gauge({
      name: 'outbox_dead',
      help: 'Teslim edilemeyip DLQ’ya düşen satır (core: event.outbox_dlq, side: dead_at dolu); 0 olmalı',
      labelNames: ['lane'],
      registers,
      async collect() {
        const r = (await store.execute(sql`
          SELECT (SELECT count(*) FROM event.outbox_dlq)::int AS core,
                 (SELECT count(*) FROM event.outbox_side WHERE dead_at IS NOT NULL)::int AS side`)) as unknown as Rows<{
          core: number;
          side: number;
        }>;
        this.set({ lane: 'core' }, r.rows[0]?.core ?? 0);
        this.set({ lane: 'side' }, r.rows[0]?.side ?? 0);
      },
    });
    collectDefaultMetrics({ register: this.registry, prefix: 'yanimda_api_' });
  }

  onModuleInit() {
    this.subscribe();
  }

  /** Testler için ayrı bus. */
  subscribe(bus: LocalBus = globalBus) {
    this.unsub?.();
    this.unsub = bus.subscribe<Transition>(TOPICS.eventTransitioned, (e) => this.onTransition(e.payload), {
      lane: 'side',
      name: 'metrics.sla',
    });
  }

  onApplicationBootstrap() {
    const port = Number(process.env.METRICS_PORT || 0);
    if (!port) return;
    this.server = createServer((req, res) => {
      if (req.url !== '/metrics') return void res.writeHead(404).end();
      this.registry
        .metrics()
        .then((m) => res.writeHead(200, { 'content-type': this.registry.contentType }).end(m))
        .catch(() => res.writeHead(500).end());
    });
    this.server.listen(port, process.env.METRICS_HOST || '0.0.0.0');
    this.log.log(`Metrikler :${port}/metrics (iç ağ)`);
  }

  onApplicationShutdown() {
    this.unsub?.();
    this.server?.close();
  }

  /** Bus aboneliği: hata fırlatmaz (outbox teslimini tekrarlatmamak için). */
  async onTransition(t: Transition, now = new Date()): Promise<void> {
    try {
      const first = t.to === 'OPERATOR_QUEUE' && t.from === 'ESCALATED';
      const claimed = t.to === 'OPERATOR_ASSIGNED' && t.from === 'OPERATOR_QUEUE';
      const decided = CONFIRMED.includes(t.to);
      if (!first && !claimed && !decided) return;
      const ev = await this.events.get(t.eventId).catch(() => null);
      if (!ev || ev.isTest) return;
      const nth = ev.transitions.filter((x) => x.to === t.to).length;
      const key = `${ev.id}:${t.to}:${nth}`;
      if (this.seen.has(key)) return;
      if (this.seen.size > 50_000) this.seen.clear();
      this.seen.add(key);
      const priority = String(ev.priority);
      const at = (s: string | undefined) => (s ? Date.parse(s) : NaN);
      const sec = (from: number) => (now.getTime() - from) / 1000;
      if (first) {
        const prompted = ev.transitions.some((x) => x.to === 'DEVICE_PROMPT');
        const start = prompted ? at(ev.escalatedAt) : await this.firstSignalAt(ev.sourceSignalIds[0], at(ev.createdAt));
        if (Number.isFinite(start)) this.signalToScreen.observe({ priority }, Math.max(0, sec(start)));
      } else if (claimed) {
        const queuedAt = [...ev.transitions].reverse().find((x) => x.to === 'OPERATOR_QUEUE')?.at;
        const assignedAt = [...ev.transitions].reverse().find((x) => x.to === 'OPERATOR_ASSIGNED')?.at;
        if (queuedAt && assignedAt)
          this.claim.observe({ priority }, Math.max(0, (at(assignedAt) - at(queuedAt)) / 1000));
      } else {
        const confirmed = ev.transitions.filter((x) => CONFIRMED.includes(x.to));
        if (confirmed.length !== 1 || !ev.escalatedAt) return; // yalnız ilk teyit
        const outcome = t.to === 'CONFIRMED_OK' ? 'ok' : 'emergency';
        this.decision.observe({ priority, outcome }, Math.max(0, (at(confirmed[0]!.at) - at(ev.escalatedAt)) / 1000));
      }
    } catch (e) {
      this.log.warn(`Metrik güncellenemedi: ${safeError(e)}`);
    }
  }

  private async firstSignalAt(key: string | undefined, fallback: number): Promise<number> {
    if (!key) return fallback;
    const r = (await this.db.execute(
      sql`SELECT received_at FROM signal.signal WHERE idempotency_key = ${key} ORDER BY received_at LIMIT 1`,
    )) as unknown as Rows<{ received_at: Date | string }>;
    const row = r.rows[0];
    return row ? new Date(row.received_at).getTime() : fallback;
  }
}
