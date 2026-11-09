import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { MetricsService } from '../src/modules/metrics/metrics.service';
import { SupervisorService } from '../src/modules/metrics/supervisor.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-025 SLA ve metrikler (E-09, D-11). Kabul: metrikler sentetik testte artar; amir özeti doğru.
 */
let h: Harness;
let timers: InMemoryTimers;
let events: EventService;
let chain: ChainService;
let metrics: MetricsService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  timers = new InMemoryTimers();
  events = h.events(timers);
  chain = new ChainService(h.db, events, loadProcedures());
  metrics = new MetricsService(h.db, events);
  metrics.subscribe(bus);
});
afterAll(async () => {
  await h.close();
});

/** Sinyal API'den girer (signal.signal + outbox), işçi teslim eder (olay + geçişler → metrikler). */
async function ingest(kind: string, person: string, extra: Record<string, unknown> = {}) {
  const r = await h.signals.accept([sig(kind, { protectedPersonId: person, ...extra })]);
  expect(r.accepted).toBe(1);
  await settle();
}
/** Outbox boşalana kadar teslim (teslim sırasında yazılan olay geçişleri sonraki turda). */
async function settle() {
  const w = h.worker();
  while ((await w.drain()) > 0);
}
const idOf = async (person: string) =>
  (await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [person]))[0]!.id;
const value = async (name: string, labels: Record<string, string> = {}) => {
  const m = (await metrics.registry.getSingleMetric(name)!.get()).values;
  return m.filter((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x));
};
const count = async (name: string, labels: Record<string, string> = {}) =>
  (await value(`${name}`, labels)).find((v) => (v as { metricName?: string }).metricName === `${name}_count`)?.value ??
  0;

describe('Prometheus metrikleri', () => {
  it('SOS → signal_to_screen ve queue_depth; üstlen → operator_claim; teyit → event_decision; kapanış → false_alarm_ratio', async () => {
    await ingest('SOS', 'pp-1');
    await ingest('SOS', 'pp-2');
    expect(await count('signal_to_screen_seconds', { priority: '1' })).toBe(2);
    expect((await value('queue_depth', { priority: '1' }))[0]!.value).toBe(2);

    const id = await idOf('pp-1');
    await chain.claim(id, 'op-1');
    await settle();
    expect(await count('operator_claim_seconds', { priority: '1' })).toBe(1);
    expect((await value('queue_depth', { priority: '1' }))[0]!.value).toBe(1);

    await chain.stepResult(id, 1, 'op-1', { result: 'REACHED', assessment: 'OK' });
    await chain.close(id, 'op-1', { outcome: 'FALSE_ALARM' });
    await settle();
    expect(await count('event_decision_seconds', { priority: '1', outcome: 'ok' })).toBe(1);
    expect((await value('false_alarm_ratio'))[0]!.value).toBe(1);

    const text = await metrics.registry.metrics();
    for (const n of [
      'signal_to_screen_seconds',
      'operator_claim_seconds',
      'event_decision_seconds',
      'queue_depth',
      'false_alarm_ratio',
    ])
      expect(text).toContain(`# TYPE ${n}`);
  });

  it('cihaz sorulu olayda sayaç yükseltmeden başlar; test olayı ölçülmez; çift teslim tek ölçüm (teyit)', async () => {
    await ingest('FALL', 'pp-f');
    const id = await idOf('pp-f');
    await timers.fire(id, 'prompt-expire'); // 60 sn sorunun süresi SLA dışı
    await settle();
    const [sum] = (await value('signal_to_screen_seconds', { priority: '1' })).filter(
      (v) => (v as { metricName?: string }).metricName === 'signal_to_screen_seconds_sum',
    );
    expect(sum!.value).toBeLessThan(5);

    await ingest('TEST', 'pp-t');
    expect(await count('signal_to_screen_seconds', { priority: '4' })).toBe(0);

    await chain.claim(id, 'op-1');
    await chain.stepResult(id, 1, 'op-1', { result: 'REACHED', assessment: 'EMERGENCY' });
    await settle();
    await metrics.onTransition({ eventId: id, from: 'CONTACT_CHAIN', to: 'CONFIRMED_EMERGENCY' }); // yeniden teslim
    expect(await count('event_decision_seconds', { priority: '1', outcome: 'emergency' })).toBe(1);
  });
});

describe('amir panosu özeti', () => {
  it('kuyruk, işlemdeki olay, aktif operatör, 24 saat sonuçları ve üstlenme SLA', async () => {
    await ingest('SOS', 'pp-a');
    await ingest('SOS', 'pp-b');
    await ingest('CALLBACK_REQUEST', 'pp-c');
    const a = await idOf('pp-a');
    await chain.claim(a, 'op-1');
    const b = await idOf('pp-b');
    await chain.claim(b, 'op-2');
    await chain.close(b, 'op-2', { outcome: 'FALSE_ALARM' });

    const d = await new SupervisorService(h.db).dashboard();
    expect(d.queue).toEqual([{ priority: 4, waiting: 1, oldestWaitSec: expect.any(Number) }]);
    expect(d.inProgress).toBe(1);
    expect(d.activeOperators).toBe(1);
    expect(d.last24h).toMatchObject({ closed: 1, byOutcome: { FALSE_ALARM: 1 }, falseAlarmRatio: 1 });
    expect(d.last24h.claim).toMatchObject({ count: 2, overSlaCount: 0 });
    expect(d.last24h.claim.p50Sec).toBeLessThan(10);
  });
});

describe('/metrics uç noktası', () => {
  it('METRICS_PORT verilince ayrı portta Prometheus metni; başka yol 404', async () => {
    const { freePort } = await import('./e2e/infra');
    const port = await freePort();
    process.env.METRICS_PORT = String(port);
    process.env.METRICS_HOST = '127.0.0.1';
    try {
      metrics.onApplicationBootstrap();
      await new Promise((r) => setTimeout(r, 50));
      const r = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('# TYPE queue_depth gauge');
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    } finally {
      metrics.onApplicationShutdown();
      delete process.env.METRICS_PORT;
      delete process.env.METRICS_HOST;
    }
  });
});
