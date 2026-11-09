import { join } from 'node:path';

import { createDevice, loadScenario } from '@yanimda/simulator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasRedisServer, type Stack, startStack, waitFor } from './infra';

/**
 * T-016 adım 1: gerçek API + Redis + Postgres(PGlite sunucusu) üzerinde simülatör senaryoları S3, S4, S7;
 * beklenen geçiş listeleri. Süreler 0,1 ölçekli (FALL penceresi 6 sn; senaryo beklemeleri de 0,1×).
 */
const SCALE = 0.1;
const SCENARIOS = join(__dirname, '../../../../packages/simulator/scenarios');

describe.skipIf(!hasRedisServer())('Senaryolar (uçtan uca)', () => {
  let st: Stack;
  beforeAll(async () => {
    st = await startStack({ timeScale: SCALE });
  });
  afterAll(async () => {
    await st?.close();
  });

  const device = (person: string) => createDevice({ api: st.api.base, person, device: `sim-${person}`, log: () => {} });
  const eventOf = async (person: string) => {
    const [row] = await st.query<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [person]);
    if (!row) return undefined;
    return (await fetch(`${st.api.base}/events/${row.id}`, { headers: st.op() })).json() as Promise<{
      id: string;
      type: string;
      state: string;
      transitions: { to: string }[];
    }>;
  };
  const transitions = (ev: { transitions: { to: string }[] }) => ev.transitions.map((t) => t.to);
  const queueIds = async () =>
    ((await (await fetch(`${st.api.base}/queue`, { headers: st.op() })).json()) as { eventId: string }[]).map(
      (q) => q.eventId,
    );

  it('S3 düşme, cevap yok → pencere dolunca operatör kuyruğu; operatör üstlenip kapatır', async () => {
    const sent = await device('pp-s3').scenario(loadScenario(join(SCENARIOS, 's3-dusme-teyitsiz.yaml')), {
      timeScale: SCALE,
    });
    expect(sent.map((s: { kind: string }) => s.kind)).toEqual(['HEARTBEAT', 'FALL', 'HEARTBEAT']);
    const ev = await waitFor(
      async () => {
        const e = await eventOf('pp-s3');
        return e?.state === 'OPERATOR_QUEUE' && e;
      },
      15_000,
      'S3 kuyruğa düşmedi',
    );
    expect(ev.type).toBe('FALL');
    expect(transitions(ev)).toEqual(['CREATED', 'DEVICE_PROMPT', 'ESCALATED', 'OPERATOR_QUEUE']);
    expect(await queueIds()).toContain(ev.id);
    const [{ n }] = await st.query<{ n: number }>(
      'SELECT count(*)::int n FROM signal.signal WHERE protected_person_id = $1',
      ['pp-s3'],
    );
    expect(n).toBe(3);

    const op = st.op();
    expect((await fetch(`${st.api.base}/events/${ev.id}/claim`, { method: 'POST', headers: op })).status).toBe(201);
    const close = await fetch(`${st.api.base}/events/${ev.id}/close`, {
      method: 'POST',
      headers: op,
      body: JSON.stringify({ outcome: 'EMERGENCY', note: '112 arandı' }),
    });
    expect(close.status).toBe(204);
    expect(transitions((await eventOf('pp-s3'))!)).toEqual([
      'CREATED',
      'DEVICE_PROMPT',
      'ESCALATED',
      'OPERATOR_QUEUE',
      'OPERATOR_ASSIGNED',
      'CONFIRMED_EMERGENCY',
      'DISPATCH',
      'CLOSED',
    ]);
  });

  it('S4 düşme, kullanıcı iptal eder → yanlış alarm, operatöre düşmez', async () => {
    await device('pp-s4').scenario(loadScenario(join(SCENARIOS, 's4-dusme-yanlis-alarm.yaml')), { timeScale: SCALE });
    const ev = await waitFor(
      async () => {
        const e = await eventOf('pp-s4');
        return e?.state === 'CLOSED' && e;
      },
      10_000,
      'S4 kapanmadı',
    );
    expect(transitions(ev)).toEqual(['CREATED', 'DEVICE_PROMPT', 'CANCELLED_BY_USER', 'CLOSED']);
    await new Promise((r) => setTimeout(r, 7_000)); // pencere (6 sn) geçti: yine de kuyruğa düşmemeli
    expect(transitions((await eventOf('pp-s4'))!)).not.toContain('ESCALATED');
    expect(await queueIds()).not.toContain(ev.id);
  });

  it('S7 saat çıkarıldı (gündüz) → bekleme + PROTECTED_PHONE', async () => {
    // Senaryo "gündüz" der: testin koştuğu saatten bağımsız olsun diye kişinin gece penceresi boş.
    await st.query(
      "INSERT INTO event.threshold (protected_person_id, sleep_start, sleep_end) VALUES ('pp-s7', '00:00', '00:00')",
    );
    await device('pp-s7').scenario(loadScenario(join(SCENARIOS, 's7-saat-cikarildi.yaml')), { timeScale: SCALE });
    const ev = await waitFor(() => eventOf('pp-s7'), 5_000, 'S7 olayı yok');
    expect(ev.type).toBe('WATCH_OFF');
    expect(transitions(ev)).toEqual(['CREATED', 'DEVICE_PROMPT']);
    const status = (await (
      await fetch(`${st.api.base}/protected-persons/pp-s7/status`, { headers: st.op() })
    ).json()) as {
      state: string;
      watch: { onWrist: boolean };
    };
    expect(status).toMatchObject({ state: 'PROTECTED_PHONE', watch: { onWrist: false } });
  });
});
