import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createDevice } from '@yanimda/simulator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasRedisServer, type Stack, startStack, waitFor } from './infra';

/**
 * T-016 adım 3 / T-080 adım 2 kaos: Redis 60 sn kapalı → sinyal kaybı yok, düşme yine zamanında yükselir, işler sonra
 * çalışır; Postgres 10 sn kapalı (yönetilen failover'ın yerel benzeri) → API 503 döner ve ayakta kalır, cihaz
 * tamponlar/yeniden dener, kayıp 0, çift 0; API kill -9 + yeniden başlatma → kayıp 0, outbox kirası düşünce kuyruk
 * toparlanır. Her durumda "kuyruk toparlanma süresi" (altyapı dönüşü → outbox birikimi 0) ölçülür; kabul < 2 dk.
 * CPaaS 500: test/cpaas-chaos.spec.ts. Ölçümler docs/test-reports için `CHAOS_REPORT` dosyasına yazılır.
 */
const SCALE = 0.1; // FALL penceresi 6 sn
const REDIS_DOWN_MS = Number(process.env.CHAOS_REDIS_DOWN_MS ?? 60_000);
const PG_DOWN_MS = Number(process.env.CHAOS_PG_DOWN_MS ?? 10_000);
const API_DOWN_MS = Number(process.env.CHAOS_API_DOWN_MS ?? 5_000);
const RECOVERY_MAX_MS = 120_000; // T-080 kabul: toparlanma < 2 dk
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = {};

describe.skipIf(!hasRedisServer())('Kaos', () => {
  let st: Stack;
  beforeAll(async () => {
    st = await startStack({ timeScale: SCALE });
  });
  afterAll(async () => {
    if (process.env.CHAOS_REPORT) {
      mkdirSync(dirname(process.env.CHAOS_REPORT), { recursive: true });
      writeFileSync(process.env.CHAOS_REPORT, JSON.stringify(report, null, 2));
    }
    await st?.close();
  });

  const device = (person: string) =>
    createDevice({
      api: st.api.base,
      person,
      device: `sim-${person}`,
      log: () => {},
      minBackoffMs: 300,
      maxBackoffMs: 2_000,
    });
  const eventState = async (person: string) =>
    (
      await st.query<{ state: string }>(
        "SELECT state FROM event.event WHERE protected_person_id = $1 AND type IN ('FALL','SOS')",
        [person],
      )
    )[0]?.state;
  /** Altyapı dönüşünden outbox'ta işlenmemiş satır kalmayana kadar geçen süre (kuyruk toparlanması). */
  const outboxDrained = async (since: number) => {
    await waitFor(
      async () =>
        (await st.query<{ n: number }>('SELECT count(*)::int n FROM event.outbox WHERE processed_at IS NULL'))[0]!.n ===
        0,
      RECOVERY_MAX_MS,
      'outbox birikimi 2 dk içinde erimedi',
    );
    return Date.now() - since;
  };
  const signalCount = async (person: string) =>
    (
      await st.query<{ n: number; keys: number }>(
        'SELECT count(*)::int n, count(DISTINCT idempotency_key)::int keys FROM signal.signal WHERE protected_person_id = $1',
        [person],
      )
    )[0];

  it(`Redis ${REDIS_DOWN_MS / 1000} sn kapalı: sinyal kaybı yok, düşme yine yükselir, Redis dönünce işler çalışır`, async () => {
    const pre = device('pp-redis-pre');
    await pre.send('FALL'); // iş Redis'e kuruldu …
    await sleep(300);
    const t0 = Date.now();
    await st.redis.stop(); // … ve Redis gitti (kalıcılıksız: iş kayboldu)

    const dur = device('pp-redis-down');
    const sent = [await dur.send('FALL')];
    for (let i = 0; i < 10; i++) sent.push(await dur.send('HEARTBEAT'));
    const dupRes = await fetch(`${st.api.base}/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([sent[1]]),
    });
    expect(await dupRes.json()).toEqual({ accepted: 0, duplicates: 1 }); // tekrar veritabanında yakalandı

    // Redis yokken: yeni FALL yerel zamanlayıcıyla (6 sn), önceki FALL süreç içi yedekle (6+15 sn) yükselir
    await waitFor(async () => (await eventState('pp-redis-down')) === 'OPERATOR_QUEUE', 15_000, 'Redis yokken FALL');
    report.redisDownFallEscalatedMs = Date.now() - t0;
    await waitFor(
      async () => (await eventState('pp-redis-pre')) === 'OPERATOR_QUEUE',
      REDIS_DOWN_MS,
      'kayıp işin yedeği',
    );
    report.redisLostJobEscalatedMs = Date.now() - t0;
    expect(await signalCount('pp-redis-down')).toEqual({ n: 11, keys: 11 });

    await sleep(Math.max(0, REDIS_DOWN_MS - (Date.now() - t0)));
    await st.redis.start();
    const t1 = Date.now();
    await sleep(1_000);

    // Redis döndü: BullMQ yolu yeniden çalışıyor
    const after = device('pp-redis-after');
    await after.send('FALL');
    await waitFor(async () => (await eventState('pp-redis-after')) === 'OPERATOR_QUEUE', 20_000, 'Redis sonrası FALL');
    report.redisRecoveredFallEscalatedMs = Date.now() - t1;
    report.redisDownMs = REDIS_DOWN_MS;
    report.redisRecoveryMs = await outboxDrained(t1);
    expect(report.redisRecoveryMs).toBeLessThan(RECOVERY_MAX_MS);
  });

  it(`Postgres ${PG_DOWN_MS / 1000} sn kapalı: API 503 ve ayakta, cihaz tamponlar, kayıp 0, çift 0`, async () => {
    const dev = device('pp-pg');
    const total = 40;
    const sends: Promise<unknown>[] = [];
    let stoppedAt = 0;
    let startedAt = 0;
    const outage = (async () => {
      await sleep(1_000);
      await st.db.stop();
      stoppedAt = Date.now();
      // kesinti sırasında API ayakta ve 503 dönüyor
      const r = await fetch(`${st.api.base}/queue`, { headers: st.op() });
      report.pgDownQueueStatus = r.status;
      report.pgDownRetryAfter = r.headers.get('retry-after');
      await sleep(PG_DOWN_MS);
      await st.db.start();
      startedAt = Date.now();
    })();
    for (let i = 0; i < total; i++) {
      sends.push(dev.send(i === 20 ? 'SOS' : 'HEARTBEAT')); // SOS kesinti ortasında
      await sleep(250);
    }
    await outage;
    await Promise.all(sends);
    await waitFor(async () => dev.pending() === 0 && true, 30_000, 'cihaz tamponu boşalmadı');
    const drainedAt = Date.now();

    expect(report.pgDownQueueStatus).toBe(503);
    expect(report.pgDownRetryAfter).toBe('2');
    expect(dev.stats.retries).toBeGreaterThan(0);
    expect(dev.stats.failed).toBe(0);
    expect(await signalCount('pp-pg')).toEqual({ n: total, keys: total }); // kayıp 0, çift 0
    await waitFor(async () => (await eventState('pp-pg')) === 'OPERATOR_QUEUE', 15_000, 'SOS kuyruğa düşmedi');
    report.pgQueueRecoveryMs = await outboxDrained(startedAt);
    expect(report.pgQueueRecoveryMs).toBeLessThan(RECOVERY_MAX_MS);
    Object.assign(report, {
      pgDownMs: startedAt - stoppedAt,
      pgRecoveryMs: drainedAt - startedAt,
      pgSignals: total,
      pgDeviceRetries: dev.stats.retries,
      pgLost: 0,
    });
  });

  it('kaos sonrası API hâlâ aynı süreç (çökmedi)', async () => {
    expect((await fetch(`${st.api.base}/queue`, { headers: st.op() })).status).toBe(200);
    const log = (await import('node:fs')).readFileSync(join(st.dir, 'api.log'), 'utf8');
    expect(log.match(/Nest application successfully started/g)).toHaveLength(1);
  });

  it(`API kill -9, ${API_DOWN_MS / 1000} sn sonra yeniden başlar: kayıp 0, çift 0, kuyruk < 2 dk toparlanır`, async () => {
    const dev = device('pp-api');
    const total = 40;
    const sends: Promise<unknown>[] = [];
    let startedAt = 0;
    const outage = (async () => {
      await sleep(1_500);
      await st.api.stop('SIGKILL'); // zarif kapanış yok: outbox kirası ve açık bağlantılar ortada kalır
      const stoppedAt = Date.now();
      await sleep(API_DOWN_MS);
      await st.api.start();
      startedAt = Date.now();
      report.apiDownMs = startedAt - stoppedAt;
    })();
    for (let i = 0; i < total; i++) {
      sends.push(dev.send(i === 15 ? 'SOS' : 'HEARTBEAT')); // SOS kesinti sırasında
      await sleep(200);
    }
    await outage;
    await Promise.all(sends);
    await waitFor(async () => dev.pending() === 0 && true, 60_000, 'cihaz tamponu boşalmadı');
    report.apiDeviceDrainMs = Date.now() - startedAt;

    expect(dev.stats.failed).toBe(0);
    expect(await signalCount('pp-api')).toEqual({ n: total, keys: total }); // kayıp 0, çift 0
    await waitFor(
      async () => (await eventState('pp-api')) === 'OPERATOR_QUEUE',
      RECOVERY_MAX_MS,
      'SOS kuyruğa düşmedi',
    );
    report.apiSosQueuedAfterRestartMs = Date.now() - startedAt;
    report.apiQueueRecoveryMs = await outboxDrained(startedAt);
    expect(report.apiQueueRecoveryMs).toBeLessThan(RECOVERY_MAX_MS);
    Object.assign(report, { apiSignals: total, apiDeviceRetries: dev.stats.retries, apiLost: 0 });
    expect((await fetch(`${st.api.base}/queue`, { headers: st.op() })).status).toBe(200);
  });
});
