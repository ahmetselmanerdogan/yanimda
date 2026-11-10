/**
 * T-080 yük testi koşturucusu: yığını açar (Redis + PGlite veya LOAD_DATABASE_URL ile gerçek TimescaleDB + API, gerçek
 * kural süreleri), 20 operatör token'ı üretir, k6'yı (infra/k6/load-v1.js) koşturur, sonra kaybı veritabanından sayar:
 *   - k6'nın kabul edildi saydığı sinyal = signal.signal satırı = tekil idempotencyKey (kayıp 0, çift 0)
 *   - gönderilen olay = event.event satırı; outbox birikimi 0, DLQ 0
 *   - API'nin kendi signal_to_screen_seconds histogramı (/metrics) k6 ölçümüyle karşılaştırılır
 * Çıktı: LOAD_OUT (varsayılan test-results/load-v1.json). Çağrı: scripts/load-v1.sh
 *
 * k6: PATH'te varsa o, yoksa Docker (grafana/k6, API'ye host.docker.internal üzerinden).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { freePort, startStack, waitFor } from './infra';

const ROOT = resolve(__dirname, '../../../..');
const OUT = resolve(process.env.LOAD_OUT ?? join(ROOT, 'test-results/load-v1.json'));
const DURATION = process.env.LOAD_DURATION ?? '30m';
const OPERATORS = Number(process.env.LOAD_OPERATORS ?? 20);
const K6_IMAGE = 'grafana/k6:0.54.0';
const K6_ARGS = process.argv.slice(2);

const durationSec = (() => {
  const m = /^(\d+)([smh])$/.exec(DURATION);
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as 's' | 'm' | 'h'] : 1800;
})();

/** Prometheus histogramından yüzdelik (kova üst sınırı; kaba ama API'den bağımsız ikinci ölçüm). */
function histQuantile(text: string, name: string, q: number) {
  const buckets = new Map<number, number>();
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${name}_bucket\\{(.*)\\} (\\d+(?:\\.\\d+)?)$`).exec(line);
    if (!m) continue;
    const le = /le="([^"]+)"/.exec(m[1]!)![1]!;
    const k = le === '+Inf' ? Infinity : Number(le);
    buckets.set(k, (buckets.get(k) ?? 0) + Number(m[2]));
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const total = sorted.at(-1)?.[1] ?? 0;
  if (!total) return { count: 0, quantileLeSec: null };
  const hit = sorted.find(([, c]) => c >= q * total)!;
  return { count: total, quantileLeSec: hit[0] };
}

async function main() {
  const metricsPort = await freePort();
  const st = await startStack({
    timeScale: 1,
    databaseUrl: process.env.LOAD_DATABASE_URL,
    env: {
      METRICS_PORT: String(metricsPort),
      METRICS_HOST: '127.0.0.1',
      ...(process.env.LOAD_POOL_MAX ? { DATABASE_POOL_MAX: process.env.LOAD_POOL_MAX } : {}),
    },
  });
  const runId = `${Date.now()}`;
  const startedAt = new Date();
  let exitCode = 1;
  let work = '';
  try {
    const tokens = Array.from({ length: OPERATORS }, (_, i) =>
      st.oidc.token({ sub: `op-load-${i + 1}`, roles: ['OPERATOR'], expInSec: durationSec + 3600 }),
    );
    // Docker Desktop yalnız paylaşılan dizinleri bağlar (/var/folders değil): çalışma dizini rapor yanında
    work = join(dirname(OUT), `load-work-${runId}`);
    mkdirSync(work, { recursive: true });
    const tokensFile = join(work, 'tokens.json');
    writeFileSync(tokensFile, JSON.stringify(tokens));
    const summaryFile = join(work, 'k6-summary.json');
    const env = [
      `DURATION=${DURATION}`,
      `OPERATORS=${OPERATORS}`,
      `RUN_ID=${runId}`,
      ...['DEVICES', 'HEARTBEAT_EVERY', 'EVENTS_PER_MIN', 'THINK_MIN_MS', 'THINK_MAX_MS']
        .filter((k) => process.env[`LOAD_${k}`])
        .map((k) => `${k}=${process.env[`LOAD_${k}`]}`),
    ];
    const stats = 'avg,min,med,p(90),p(95),p(99),max';
    const local = spawnSync('k6', ['version']).status === 0;
    const script = join(ROOT, 'infra/k6/load-v1.js');
    const [cmd, args] = local
      ? [
          'k6',
          [
            'run',
            '--no-color',
            `--summary-trend-stats=${stats}`,
            '--summary-export',
            summaryFile,
            ...env.flatMap((e) => ['-e', e]),
            '-e',
            `API_URL=${st.api.base}`,
            '-e',
            `TOKENS_FILE=${tokensFile}`,
            ...K6_ARGS,
            script,
          ],
        ]
      : [
          'docker',
          [
            'run',
            '--rm',
            '--add-host=host.docker.internal:host-gateway',
            '-v',
            `${script}:/scripts/load-v1.js:ro`,
            '-v',
            `${work}:/work`,
            K6_IMAGE,
            'run',
            '--no-color',
            `--summary-trend-stats=${stats}`,
            '--summary-export',
            '/work/k6-summary.json',
            ...env.flatMap((e) => ['-e', e]),
            '-e',
            `API_URL=${st.api.base.replace('127.0.0.1', 'host.docker.internal')}`,
            '-e',
            'TOKENS_FILE=/work/tokens.json',
            ...K6_ARGS,
            '/scripts/load-v1.js',
          ],
        ];
    console.log(`yük testi: ${DURATION}, ${OPERATORS} operatör, k6 ${local ? 'yerel' : K6_IMAGE}, API ${st.api.base}`);
    // Outbox birikimi örneklemesi (10 sn): tek işçi FIFO; heartbeat birikimi SOS'u bekletir mi (baş-sıra tıkanması)
    const backlog: { t: number; pending: number; oldestSec: number }[] = [];
    const sampler = setInterval(() => {
      st.query<{ pending: number; oldest: number | null }>(
        `SELECT count(*)::int pending, extract(epoch FROM now() - min(created_at))::float oldest
           FROM event.outbox WHERE processed_at IS NULL`,
      )
        .then(([r]) => backlog.push({ t: Date.now(), pending: r!.pending, oldestSec: Math.round(r!.oldest ?? 0) }))
        .catch(() => undefined);
    }, 10_000);
    const k6Exit = await new Promise<number>((r) =>
      spawn(cmd as string, args as string[], { stdio: 'inherit' }).on('exit', (c) => r(c ?? 1)),
    );

    clearInterval(sampler);
    // k6 bitti: outbox'ın erimesini bekle, sonra say
    const settleT0 = Date.now();
    await waitFor(
      async () =>
        (await st.query<{ n: number }>('SELECT count(*)::int n FROM event.outbox WHERE processed_at IS NULL'))[0]!.n ===
        0,
      120_000,
      'outbox birikimi erimedi',
    );
    const settleMs = Date.now() - settleT0;
    const k6 = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      metrics: Record<string, Record<string, number> & { thresholds?: Record<string, boolean> }>;
    };
    const m = (k: string) => k6.metrics[k] ?? {};
    const [sig] = await st.query<{ n: number; keys: number }>(
      `SELECT count(*)::int n, count(DISTINCT idempotency_key)::int keys FROM signal.signal
        WHERE device_id LIKE 'k6-%' AND received_at >= $1`,
      [startedAt],
    );
    const events = await st.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int n FROM event.event WHERE protected_person_id LIKE $1 GROUP BY state ORDER BY state`,
      [`k6-ev-${runId}-%`],
    );
    const [dlq] = await st.query<{ n: number }>('SELECT count(*)::int n FROM event.outbox_dlq');
    const metricsText = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();

    const accepted = m('signals_accepted').count ?? 0;
    const eventsSent = m('events_sent').count ?? 0;
    const eventsInDb = events.reduce((a, e) => a + e.n, 0);
    const report = {
      task: 'T-080',
      startedAt: startedAt.toISOString(),
      duration: DURATION,
      database: process.env.LOAD_DATABASE_URL ? 'external (LOAD_DATABASE_URL)' : 'pglite',
      k6: {
        exitCode: k6Exit,
        signalToScreenMs: m('signal_to_screen'),
        operatorClaimMs: m('operator_claim'),
        signalsPostMs: m('http_req_duration{name:signals}'),
        httpReqs: m('http_reqs').count,
        httpFailedRate: m('http_req_failed').value,
        wsErrors: m('ws_errors').count ?? 0,
        claimOkRate: m('claim_ok').value,
        eventsSent,
        eventsClosed: m('events_closed').count ?? 0,
        signalsAccepted: accepted,
        signalsDuplicates: m('signals_duplicates').count ?? 0,
      },
      db: { signalRows: sig!.n, signalKeys: sig!.keys, eventsByState: events, eventsInDb, outboxDlq: dlq!.n },
      loss: { signals: accepted - sig!.n, duplicates: sig!.n - sig!.keys, events: eventsSent - eventsInDb },
      queueSettleMs: settleMs,
      outboxBacklog: {
        samples: backlog.length,
        maxPending: Math.max(0, ...backlog.map((b) => b.pending)),
        maxOldestSec: Math.max(0, ...backlog.map((b) => b.oldestSec)),
        series: backlog.map((b) => [Math.round((b.t - startedAt.getTime()) / 1000), b.pending, b.oldestSec]),
      },
      apiMetrics: {
        signalToScreenP95LeSec: histQuantile(metricsText, 'signal_to_screen_seconds', 0.95),
        operatorClaimP95LeSec: histQuantile(metricsText, 'operator_claim_seconds', 0.95),
      },
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    const ok =
      k6Exit === 0 &&
      report.loss.signals === 0 &&
      report.loss.duplicates === 0 &&
      report.loss.events === 0 &&
      report.db.outboxDlq === 0;
    console.log(ok ? 'T-080 yük: GEÇTİ' : 'T-080 yük: KALDI');
    exitCode = ok ? 0 : 1;
  } finally {
    await st.close();
    if (work) rmSync(join(work, 'tokens.json'), { force: true }); // token'lar diskte kalmaz
  }
  process.exit(exitCode);
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
