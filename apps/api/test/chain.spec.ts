import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { buildSteps, loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { loadRulePack, ruleFor } from '../src/modules/event/rules.loader';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-021 prosedür ve zincir (D-03, D-04). Kabul:
 *  - şablon testi: her olay tipi için adım sayısı ve sırası
 *  - sıra dışı sonuç 409; SKIPPED gerekçe ister
 *  - kilit süresi dolunca kuyruğa dönüş (zaman enjekte edilir) + amir uyarısı outbox'ta
 *  - adım sonuçları geçiş tetikler: kullanıcı iyi → CONFIRMED_OK; 112 → CONFIRMED_EMERGENCY → DISPATCH
 */
const pack = loadRulePack('TR');
const proc = loadProcedures('TR');
const OP = 'op-1';
const OP2 = 'op-2';

let h: Harness;
let events: EventService;
let chain: ChainService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  events = h.events(new InMemoryTimers());
  chain = new ChainService(h.db, events, proc);
});
afterAll(async () => {
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);

/** SOS (cihaz sorusu yok) → doğrudan OPERATOR_QUEUE. */
async function queued(kind = 'SOS', person = 'pp-1', extra: Record<string, unknown> = {}) {
  await deliver(sig(kind, { protectedPersonId: person, ...extra }));
  const [row] = await h.rows<{ id: string; state: string }>(
    'SELECT id, state FROM event.event WHERE protected_person_id = $1',
    [person],
  );
  expect(row!.state).toBe('OPERATOR_QUEUE');
  return row!.id;
}
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status ?? (e as Error).message;
  }
};
/** T-087 SOS zinciri; anahtar sahibi kayıtlı değilse o adım sistemce atlanır, 112 7. adımdır. */
const SOS_KINDS = [
  'CALL_WATCH',
  'CALL_PHONE',
  'CALL_REDIAL',
  'CALL_CONTACT',
  'CALL_CONTACT',
  'CALL_KEY_HOLDER',
  'CALL_112',
];
const N112 = 7;
/** Kişiye ve yakınlara ulaşılamadı (1–5 cevapsız; 6 anahtar sahibi yok → atlandı): sıradaki 112. */
const toStep112 = async (id: string) => {
  for (const n of [1, 2, 3, 4, 5]) await chain.stepResult(id, n, OP, { result: 'NO_ANSWER' });
};
const states = async (id: string) =>
  (
    await h.rows<{ to_state: string }>('SELECT to_state FROM event.transition WHERE event_id = $1 ORDER BY seq', [id])
  ).map((r) => r.to_state);

describe('prosedür şablonu', () => {
  const kinds = (type: Parameters<typeof ruleFor>[1], test = false) =>
    buildSteps(ruleFor(pack, type)!, test, proc).map((s) => (s.contactIndex ? `${s.kind}:${s.contactIndex}` : s.kind));

  it.each([
    // T-087 (docs/07 S5.2, S5.4): sesli cihaz → telefon → en iyi cihaza yeniden → yakınlar → anahtar sahibi → 112
    [
      'SOS',
      ['CALL_WATCH', 'CALL_PHONE', 'CALL_REDIAL', 'CALL_CONTACT:1', 'CALL_CONTACT:2', 'CALL_KEY_HOLDER', 'CALL_112'],
    ],
    [
      'FALL',
      [
        'CALL_WATCH',
        'CALL_PHONE',
        'CALL_REDIAL',
        'CALL_CONTACT:1',
        'CALL_CONTACT:2',
        'CALL_KEY_HOLDER',
        'CALL_NEIGHBOR',
        'CALL_112',
      ],
    ],
    [
      'INACTIVITY',
      ['CALL_WATCH', 'CALL_PHONE', 'CALL_CONTACT:1', 'CALL_CONTACT:2', 'CALL_KEY_HOLDER', 'CALL_NEIGHBOR', 'CALL_112'],
    ],
    ['WATCH_OFF', ['CALL_PHONE', 'CALL_CONTACT:1']],
    ['BATTERY_LOW', ['NOTIFY_FAMILY']],
    ['BATTERY_DEAD', ['CALL_PHONE', 'CALL_CONTACT:1']],
    ['CONNECTION_LOST', ['CALL_PHONE', 'CALL_CONTACT:1']],
    ['CALLBACK', ['CALL_PHONE']],
    ['TEST', ['CALL_WATCH', 'CALL_PHONE']],
    ['FOLLOW_UP', ['CALL_PHONE', 'CALL_CONTACT:1']],
  ] as const)('%s: adım sayısı ve sırası', (type, expected) => {
    expect(kinds(type)).toEqual(expected);
  });

  it('kural paketindeki her tip için şablon var; süreler pakette, etiket/metin katalogda', () => {
    for (const r of pack.rules) expect(buildSteps(r, false, proc).length).toBe(r.chain.length);
    const fall = buildSteps(ruleFor(pack, 'FALL')!, false, proc);
    expect(fall.map((s) => s.timeoutSec)).toEqual([20, 20, 15, 25, 25, 25, 25, 0]);
    expect(fall[0]).toMatchObject({ n: 1, label: 'O-STEP-WATCH', script: 'O-SCRIPT-ELDER', target: 'WATCH' });
    expect(fall[2]).toMatchObject({ n: 3, kind: 'CALL_REDIAL', target: 'VOICE_DEVICE', label: 'O-STEP-REDIAL' });
    expect(fall[3]).toMatchObject({ n: 4, contactIndex: 1, label: 'O-STEP-CONTACT' });
    expect(fall[5]).toMatchObject({ kind: 'CALL_KEY_HOLDER', target: 'KEY_HOLDER', required: false });
    expect(fall[6]).toMatchObject({ kind: 'CALL_NEIGHBOR', required: false });
  });

  it('test olayında 112 yok', () => {
    expect(kinds('SOS', true)).toEqual([
      'CALL_WATCH',
      'CALL_PHONE',
      'CALL_REDIAL',
      'CALL_CONTACT:1',
      'CALL_CONTACT:2',
      'CALL_KEY_HOLDER',
    ]);
  });
});

describe('üstlenme ve zincir', () => {
  it('üstlenince zincir oluşur (OPERATOR_ASSIGNED, sıradaki adım 1); ikinci operatör 409', async () => {
    const id = await queued();
    const r = await chain.claim(id, OP);
    expect(r.event.state).toBe('OPERATOR_ASSIGNED');
    expect(r.chain!.steps.map((s) => s.kind)).toEqual(SOS_KINDS);
    expect(r.chain!.current).toBe(1);
    expect(await status(chain.claim(id, OP2))).toBe(409);
    expect((await chain.claim(id, OP)).chain!.steps).toHaveLength(SOS_KINDS.length); // aynı operatör: aynı zincir
    const [{ n }] = await h.rows<{ n: number }>('SELECT count(*)::int n FROM chain.chain_run');
    expect(n).toBe(1);
  });

  it('eş zamanlı üstlenme: biri 200 biri 409', async () => {
    const id = await queued();
    const res = await Promise.allSettled([chain.claim(id, OP), chain.claim(id, OP2)]);
    expect(res.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(409);
  });

  it('sahibi olmayan operatör adım işleyemez (409)', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    expect(await status(chain.stepResult(id, 1, OP2, { result: 'NO_ANSWER' }))).toBe(409);
  });

  it('cevap yok → sıradaki adım; ilk sonuç CONTACT_CHAIN', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    const r = await chain.stepResult(id, 1, OP, { result: 'NO_ANSWER' });
    expect(r.event.state).toBe('CONTACT_CHAIN');
    expect(r.chain!.current).toBe(2);
    expect(r.chain!.steps[0]).toMatchObject({ result: 'NO_ANSWER', operatorId: OP });
    expect(r.chain!.steps[0]!.completedAt).toBeDefined();
  });

  it('sıra dışı sonuç 409; geçersiz sonuç 400; SKIPPED gerekçesiz 400', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    expect(await status(chain.stepResult(id, 2, OP, { result: 'NO_ANSWER' }))).toBe(409);
    expect(await status(chain.stepResult(id, 1, OP, { result: 'MAYBE' }))).toBe(400);
    expect(await status(chain.stepResult(id, 1, OP, { result: 'SKIPPED' }))).toBe(400);
    expect(await status(chain.stepResult(id, 1, OP, { result: 'BUSY', assessment: 'OK' }))).toBe(400);
    const r = await chain.stepResult(id, 1, OP, { result: 'SKIPPED', reason: 'saat çevrimdışı' });
    expect(r.chain!.steps[0]).toMatchObject({ result: 'SKIPPED', reason: 'saat çevrimdışı' });
    expect(await status(chain.stepResult(id, 1, OP, { result: 'NO_ANSWER' }))).toBe(409); // tekrar yazılamaz
  });

  it('"Ara": arama zamanı yazılır, olay CONTACT_CHAIN', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    const at = new Date();
    const r = await chain.call(id, 1, OP, at);
    expect(r.chain!.steps[0]!.calledAt).toBe(at.toISOString());
    expect(r.event.state).toBe('CONTACT_CHAIN');
  });

  it('ulaşıldı + kişi iyi → CONFIRMED_OK, kalan adımlar atlanır, kapatma OK', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    await chain.stepResult(id, 1, OP, { result: 'NO_ANSWER' });
    const r = await chain.stepResult(id, 2, OP, { result: 'REACHED', assessment: 'OK', note: 'yanlışlıkla bastı' });
    expect(r.event.state).toBe('CONFIRMED_OK');
    expect(r.chain!.current).toBeNull();
    expect(r.chain!.steps.slice(2).map((s) => [s.result, s.reason])).toEqual(
      Array(SOS_KINDS.length - 2).fill(['SKIPPED', 'resolved']),
    );
    expect(await status(chain.close(id, OP, { outcome: 'EMERGENCY' }))).toBe(409);
    await chain.close(id, OP, { outcome: 'FALSE_ALARM' });
    expect(await states(id)).toEqual([
      'CREATED',
      'ESCALATED',
      'OPERATOR_QUEUE',
      'OPERATOR_ASSIGNED',
      'CONTACT_CHAIN',
      'CONFIRMED_OK',
      'CLOSED',
    ]);
  });

  it('112 adımı ulaşıldı → CONFIRMED_EMERGENCY → DISPATCH; kapatma EMERGENCY', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    await toStep112(id);
    const r = await chain.stepResult(id, N112, OP, { result: 'REACHED' });
    expect(r.event.state).toBe('DISPATCH');
    expect(await status(chain.close(id, OP, { outcome: 'OK' }))).toBe(409);
    await chain.close(id, OP, { outcome: 'EMERGENCY', note: 'ambulans yolda' });
    expect((await states(id)).slice(-4)).toEqual(['CONTACT_CHAIN', 'CONFIRMED_EMERGENCY', 'DISPATCH', 'CLOSED']);
  });

  it('112 meşgul → yeni 112 adımı (tekrar dene)', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    await toStep112(id);
    const r = await chain.stepResult(id, N112, OP, { result: 'BUSY' });
    expect(r.chain!.steps.map((s) => s.kind)).toEqual([...SOS_KINDS, 'CALL_112']);
    expect(r.chain!.current).toBe(N112 + 1);
  });

  it('ulaşıldı + acil → CONFIRMED_EMERGENCY, aradaki adımlar atlanır, sıradaki 112', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    const r = await chain.stepResult(id, 1, OP, { result: 'REACHED', assessment: 'EMERGENCY' });
    expect(r.event.state).toBe('CONFIRMED_EMERGENCY');
    expect(r.chain!.steps.slice(1, N112 - 1).map((s) => s.reason)).toEqual(Array(N112 - 2).fill('emergency'));
    expect(r.chain!.current).toBe(N112);
    expect(await status(chain.stepResult(id, N112, OP, { result: 'REACHED' }))).toBe('ok');
  });

  it('Ctrl+1 112 kısayolu: gerekçe zorunlu; kalan adımlar SKIPPED(escalate); test olayında 112 eklenir', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    expect(await status(chain.escalate112(id, OP, {}))).toBe(400);
    const r = await chain.escalate112(id, OP, { reason: 'sessiz hat, nefes sesi' });
    expect(r.event.state).toBe('CONFIRMED_EMERGENCY');
    expect(r.chain!.steps.slice(0, N112 - 1).map((s) => [s.result, s.reason, s.note])).toEqual(
      Array(N112 - 1).fill(['SKIPPED', 'escalate', 'sessiz hat, nefes sesi']),
    );
    expect(r.chain!.current).toBe(N112);

    const t = await queued('TEST', 'pp-test');
    await chain.claim(t, OP);
    const rt = await chain.escalate112(t, OP, { reason: 'gerçek acil' });
    expect(rt.chain!.steps.map((s) => s.kind)).toEqual(['CALL_WATCH', 'CALL_PHONE', 'CALL_112']);
    expect(rt.chain!.current).toBe(3);
  });

  it('adım sonucu outbox (chain.step.result) ve audit.log; not metni audit’e yazılmaz', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    await chain.stepResult(id, 1, OP, { result: 'NO_ANSWER', note: 'Ayşe Hanım telefonu kapalı' });
    const [o] = await h.rows<{ payload: { payload: Record<string, unknown> } }>(
      "SELECT envelope AS payload FROM event.outbox WHERE topic = 'chain.step.result'",
    );
    expect(o!.payload.payload).toMatchObject({ eventId: id, n: 1, kind: 'CALL_WATCH', result: 'NO_ANSWER' });
    const audit = await h.rows<{ data: unknown }>("SELECT data FROM audit.log WHERE action = 'chain.step.result'");
    expect(JSON.stringify(audit)).not.toContain('Ayşe');
  });
});

describe('operatör kilidi (D-04)', () => {
  it('her istek kilidi uzatır; süre dolunca olay kuyruğa döner ve amir uyarısı outbox’a yazılır', async () => {
    const id = await queued();
    const t0 = new Date();
    await chain.claim(id, OP, t0);
    const lock = async () =>
      (await h.rows<{ lock_until: Date }>('SELECT lock_until FROM event.event WHERE id = $1', [id]))[0]!.lock_until;
    expect((await lock()).getTime()).toBe(t0.getTime() + 300_000);

    const t1 = new Date(t0.getTime() + 200_000);
    await chain.stepResult(id, 1, OP, { result: 'NO_ANSWER' }, t1);
    expect((await lock()).getTime()).toBe(t1.getTime() + 300_000);

    expect(await events.releaseExpiredLocks(new Date(t1.getTime() + 299_000))).toBe(0);
    expect(await events.releaseExpiredLocks(new Date(t1.getTime() + 301_000))).toBe(1);
    const ev = await events.get(id);
    expect(ev).toMatchObject({ state: 'OPERATOR_QUEUE', operatorId: undefined, lockUntil: undefined });
    expect((await states(id)).slice(-2)).toEqual(['CONTACT_CHAIN', 'OPERATOR_QUEUE']);
    const [alert] = await h.rows<{ payload: { payload: Record<string, unknown> } }>(
      "SELECT envelope AS payload FROM event.outbox WHERE topic = 'supervisor.alert'",
    );
    expect(alert!.payload.payload).toMatchObject({
      code: 'O-LOCK-LOST',
      eventId: id,
      operatorId: OP,
      eventType: 'SOS',
    });

    // eski operatör artık işleyemez; başka operatör üstlenir ve zincir kaldığı yerden sürer
    expect(await status(chain.stepResult(id, 2, OP, { result: 'NO_ANSWER' }))).toBe(409);
    const r = await chain.claim(id, OP2, new Date(t1.getTime() + 301_000));
    expect(r.chain!.current).toBe(2);
    expect(await events.releaseExpiredLocks(new Date(t1.getTime() + 302_000))).toBe(0); // yeni kilit taze
  });

  it('teyit edilmiş olay kilit dolunca operatörde kalır, yalnız amir uyarısı (bir kez)', async () => {
    const id = await queued();
    const t0 = new Date();
    await chain.claim(id, OP, t0);
    await chain.stepResult(id, 1, OP, { result: 'REACHED', assessment: 'EMERGENCY' }, t0);
    const later = new Date(t0.getTime() + 400_000);
    expect(await events.releaseExpiredLocks(later)).toBe(1);
    expect(await events.releaseExpiredLocks(later)).toBe(0);
    expect(await events.get(id)).toMatchObject({ state: 'CONFIRMED_EMERGENCY', operatorId: OP });
    expect(await status(chain.stepResult(id, N112, OP, { result: 'REACHED' }))).toBe('ok'); // operatör sürdürür
  });

  it('kilidi dolan acil teyitli olayı başka operatör devralır, 112 adımını sürdürür; eski operatör 409', async () => {
    const id = await queued();
    const t0 = new Date();
    await chain.claim(id, OP, t0);
    await chain.stepResult(id, 1, OP, { result: 'REACHED', assessment: 'EMERGENCY' }, t0);
    // kilit dolmadan devralınamaz
    expect(await status(chain.claim(id, OP2, new Date(t0.getTime() + 60_000)))).toBe(409);
    const later = new Date(t0.getTime() + 400_000);
    await events.releaseExpiredLocks(later);
    const taken = await chain.claim(id, OP2, later);
    expect(taken.event).toMatchObject({ state: 'CONFIRMED_EMERGENCY', operatorId: OP2 });
    expect(new Date(taken.event.lockUntil!).getTime()).toBe(later.getTime() + 300_000);
    expect(await status(chain.stepResult(id, N112, OP, { result: 'REACHED' }, later))).toBe(409);
    expect(await status(chain.stepResult(id, N112, OP2, { result: 'REACHED' }, later))).toBe('ok');
    const audit = await h.rows<{ actor_id: string; data: unknown }>(
      "SELECT actor_id, data FROM audit.log WHERE action = 'event.taken_over' AND entity_id = $1",
      [id],
    );
    expect(audit).toEqual([{ actor_id: OP2, data: { from: OP, state: 'CONFIRMED_EMERGENCY' } }]);
    const topics = await h.rows<{ envelope: { payload: { reason?: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'event.updated'",
    );
    expect(topics.some((r) => r.envelope.payload.reason === 'TAKEN_OVER')).toBe(true);
  });

  it('kilit süresi dolmuş ama tarama henüz geçmemiş operatördeki olay da devralınır', async () => {
    const id = await queued();
    const t0 = new Date();
    await chain.claim(id, OP, t0);
    const later = new Date(t0.getTime() + 301_000);
    expect((await chain.claim(id, OP2, later)).event).toMatchObject({ state: 'OPERATOR_ASSIGNED', operatorId: OP2 });
  });

  it('kapatılan olayın kilidi temizlenir', async () => {
    const id = await queued();
    await chain.claim(id, OP);
    await chain.close(id, OP, { outcome: 'UNREACHABLE', note: 'kimseye ulaşılamadı' });
    const ev = await events.get(id);
    expect(ev).toMatchObject({ state: 'CLOSED', lockUntil: undefined, confirmedOutcome: 'UNREACHABLE' });
    expect((await states(id)).slice(-3)).toEqual(['OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CLOSED']);
    const steps = (await chain.get(id)).chain!.steps;
    expect(steps.every((s) => s.result === 'SKIPPED' && s.reason === 'closed')).toBe(true);
  });
});
