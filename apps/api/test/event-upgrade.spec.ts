import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * İnceleme bulgusu 1 (D-02 adım 3): alarm olmayan açık olay (TEST, CALLBACK, FOLLOW_UP, WATCH_OFF …) gerçek alarmı
 * (SOS/FALL/INACTIVITY) yutmamalı. Olay alarma yükseltilir: tür + öncelik + test bayrağı, zincir yeniden planlanır
 * (112 dahil), aileye alarm bildirimi gider.
 */
const proc = loadProcedures('TR');
const OP = 'op-1';
const P = 'pp-up';

let h: Harness;
let timers: InMemoryTimers;
let events: EventService;
let chain: ChainService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  timers = new InMemoryTimers();
  events = h.events(timers);
  chain = new ChainService(h.db, events, proc);
});
afterAll(async () => {
  await h.close();
});

const deliver = (kind: string, extra: Record<string, unknown> = {}) =>
  bus.deliver<Signal>('signal.received', {
    payload: sig(kind, { protectedPersonId: P, ...extra }),
  } as unknown as KafkaEnvelope<Signal>);
const only = async () => {
  const all = await events.all();
  expect(all).toHaveLength(1);
  return events.get(all[0].id);
};
const familyCodes = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string; audience: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id",
    )
  )
    .map((r) => r.envelope.payload)
    .filter((p) => p.audience === 'FAMILY')
    .map((p) => p.code);
const kinds = (steps: { kind: string; result?: string | null; reason?: string | null }[]) =>
  steps.map((s) => `${s.kind}${s.result ? `=${s.result}` : ''}${s.reason ? `(${s.reason})` : ''}`);

describe('alarm olmayan açık olaya gerçek alarm → yükseltme', () => {
  it('kuyruktaki TEST olayına SOS → SOS, P1, test değil; audit + aileye F-EVT-SOS', async () => {
    await deliver('TEST');
    const test = await only();
    expect(test).toMatchObject({ type: 'TEST', isTest: true, priority: 4, state: 'OPERATOR_QUEUE' });
    await deliver('SOS');
    const ev = await only();
    expect(ev).toMatchObject({ type: 'SOS', isTest: false, priority: 1, state: 'OPERATOR_QUEUE' });
    expect(ev.sourceSignalIds).toHaveLength(2);
    const [audit] = await h.rows<{ data: Record<string, unknown> }>(
      "SELECT data FROM audit.log WHERE action = 'event.type_upgraded' AND entity_id = $1",
      [test.id],
    );
    expect(audit!.data).toMatchObject({ from: 'TEST', to: 'SOS', wasTest: true });
    expect(await familyCodes()).toContain('F-EVT-SOS');
  });

  it('operatör TEST zincirini yürütürken SOS → bekleyen adımlar atlanır, SOS planı (112 dahil) eklenir', async () => {
    await deliver('TEST');
    const id = (await only()).id;
    const claimed = await chain.claim(id, OP);
    expect(kinds(claimed.chain!.steps)).toEqual(['CALL_WATCH', 'CALL_PHONE']);

    await deliver('SOS');
    expect(await only()).toMatchObject({ type: 'SOS', isTest: false, priority: 1, state: 'OPERATOR_ASSIGNED' });

    const after = await chain.claim(id, OP); // aynı operatör: zincir yeniden planlanır
    expect(kinds(after.chain!.steps)).toEqual([
      'CALL_WATCH=SKIPPED(upgraded)',
      'CALL_PHONE=SKIPPED(upgraded)',
      'CALL_WATCH',
      'CALL_PHONE',
      'CALL_CONTACT',
      'CALL_112',
    ]);
    expect(after.chain!.current).toBe(3);
    expect(await familyCodes()).toContain('F-EVT-SOS');
  });

  it('CALLBACK olayına FALL → FALL, P1 (operatöre; kişi sorusu açılmaz)', async () => {
    await deliver('CALLBACK_REQUEST');
    expect(await only()).toMatchObject({ type: 'CALLBACK', priority: 4 });
    await deliver('FALL');
    expect(await only()).toMatchObject({ type: 'FALL', priority: 1, isTest: false, state: 'OPERATOR_QUEUE' });
    expect(await familyCodes()).toContain('F-EVT-FALL');
  });

  it('saat çıkarıldı beklemesindeyken SOS → SOS olayı, hemen kuyruğa, bekleme zamanlayıcıları silinir', async () => {
    await deliver('OFF_BODY', { occurredAt: '2026-11-08T11:00:00Z' });
    expect(await only()).toMatchObject({ type: 'WATCH_OFF', state: 'DEVICE_PROMPT' });
    await deliver('SOS');
    const ev = await only();
    expect(ev).toMatchObject({ type: 'SOS', priority: 1, state: 'OPERATOR_QUEUE' });
    expect(ev.transitions.find((t) => t.to === 'ESCALATED')!.note).toBe('SOS geldi');
    expect(timers.pendingIds()).toEqual([]);
    // Kuyruğa giriş SOS türüyle oldu: aile bildirimi geçişten gelir (bu servis yalnız bekleme öncesini yazmaz).
    expect(await familyCodes()).not.toContain('F-WATCH-OFF-4H');
  });

  it('alarm olaya ikinci alarm türü → tür değişmez (FALL + SOS = FALL, P1)', async () => {
    await deliver('FALL');
    await deliver('SOS');
    const ev = await only();
    expect(ev).toMatchObject({ type: 'FALL', priority: 1 });
    expect(
      await h.rows("SELECT 1 FROM audit.log WHERE action = 'event.type_upgraded' AND entity_id = $1", [ev.id]),
    ).toHaveLength(0);
  });

  it('alarm olmayan sinyal alarm olmayan olaya eklenir: tür değişmez, daha acil öncelik alınır (bulgu 7b)', async () => {
    await deliver('CALLBACK_REQUEST');
    await deliver('OFF_BODY', { occurredAt: '2026-11-08T11:00:00Z' });
    expect(await only()).toMatchObject({ type: 'CALLBACK', priority: 3 }); // WATCH_OFF P3 > CALLBACK P4
  });

  it('kapatılmış TEST sonrası SOS yeni olay açar (yükseltme yalnız açık olaya)', async () => {
    await deliver('TEST');
    const t = await only();
    await events.closeByOperator((await chain.claim(t.id, OP)).event.id, OP, 'TEST');
    await deliver('SOS');
    const all = await events.all();
    expect(all.map((e) => e.type).sort()).toEqual(['SOS', 'TEST']);
  });
});
