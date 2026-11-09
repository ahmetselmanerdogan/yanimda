import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { oidcConfigFromEnv, OidcVerifier } from '../src/modules/identity/oidc-verifier';
import { QUEUE_WS_PATH, QueueGateway, type QueueMessage } from '../src/modules/queue/queue.gateway';
import { type FakeOidc, startFakeOidc } from './support/fake-oidc';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-022 canlı kuyruk (E-02). Kabul:
 *  - GET /v1/queue sayfalı, öncelik → yaş, lockedBy dahil
 *  - iki istemci aynı olayı aynı anda üstlenir → biri 200 biri 409 (servis düzeyi chain.spec'te; HTTP e2e'de)
 *  - WS'de 1 sn içinde yeni olay görünür; yeniden bağlanınca tam liste
 *  - amir unclaim
 */
let h: Harness;
let idp: FakeOidc;
let events: EventService;
let chain: ChainService;
beforeAll(async () => {
  h = await createHarness();
  idp = await startFakeOidc();
});
beforeEach(async () => {
  await h.reset();
  events = h.events(new InMemoryTimers());
  chain = new ChainService(h.db, events, loadProcedures());
});
afterAll(async () => {
  await idp.close();
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const idOf = async (person: string) =>
  (await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [person]))[0]!.id;

describe('kuyruk sorgusu', () => {
  it('öncelik → yaş; sayfalı; lockedBy ve kişi bilgisi', async () => {
    const PERSON = '00000000-0000-0000-0000-0000000000b1';
    await h.pg.exec(
      `INSERT INTO profile.protected_person (id, display_name, birth_year) VALUES ('${PERSON}', 'Fatma Y.', 1946)`,
    );
    await deliver(sig('INACTIVITY', { protectedPersonId: 'pp-p2', value: 45 })); // P2, cihaz sorusu → kuyrukta değil
    await deliver(sig('SOS', { protectedPersonId: 'pp-a' }));
    await new Promise((r) => setTimeout(r, 5));
    await deliver(sig('SOS', { protectedPersonId: PERSON }));
    await deliver(sig('CALLBACK_REQUEST', { protectedPersonId: 'pp-cb' }));

    const all = await events.queuePage({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items.map((i) => [i.type, i.priority])).toEqual([
      ['SOS', 1],
      ['SOS', 1],
      ['CALLBACK', 4],
    ]);
    expect(all.items[1]!.person).toEqual({ displayName: 'Fatma Y.', age: new Date().getUTCFullYear() - 1946 });
    expect(all.items[0]!.person).toBeNull();

    await chain.claim(all.items[0]!.eventId, 'op-1');
    const p1 = await events.queuePage({ limit: 1, offset: 0 });
    expect(p1).toMatchObject({ total: 3, items: [{ lockedBy: 'op-1', state: 'OPERATOR_ASSIGNED' }] });
    expect(p1.items[0]!.lockUntil).not.toBeNull();
    const p3 = await events.queuePage({ limit: 1, offset: 2 });
    expect(p3.items.map((i) => i.type)).toEqual(['CALLBACK']);
  });

  it('kapatılan olay kuyruktan düşer; queueItem null', async () => {
    await deliver(sig('SOS', { protectedPersonId: 'pp-c' }));
    const id = await idOf('pp-c');
    expect(await events.queueItem(id)).toMatchObject({ eventId: id, state: 'OPERATOR_QUEUE' });
    await chain.claim(id, 'op-1');
    await chain.close(id, 'op-1', { outcome: 'FALSE_ALARM' });
    expect(await events.queueItem(id)).toBeNull();
    expect((await events.queuePage({ limit: 50, offset: 0 })).total).toBe(0);
  });
});

describe('amir unclaim', () => {
  it('operatördeki olay kuyruğa döner, zincir kalır; teyitli olay 409', async () => {
    await deliver(sig('SOS', { protectedPersonId: 'pp-u' }));
    const id = await idOf('pp-u');
    await chain.claim(id, 'op-1');
    await chain.stepResult(id, 1, 'op-1', { result: 'NO_ANSWER' });
    const ev = await events.unclaim(id, 'sup-1', 'operatör molada');
    expect(ev).toMatchObject({ state: 'OPERATOR_QUEUE', operatorId: undefined, lockUntil: undefined });
    expect(ev.transitions.at(-1)).toMatchObject({ to: 'OPERATOR_QUEUE', actorId: 'sup-1', note: 'operatör molada' });
    expect((await chain.claim(id, 'op-2')).chain!.current).toBe(2);
    await chain.stepResult(id, 2, 'op-2', { result: 'REACHED', assessment: 'OK' });
    await expect(events.unclaim(id, 'sup-1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('WebSocket /v1/ws/queue', () => {
  let server: Server;
  let gw: QueueGateway;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${QUEUE_WS_PATH}`;
    gw = new QueueGateway(events, new OidcVerifier(oidcConfigFromEnv(idp.env)), undefined);
    gw.attach(server, bus);
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await gw.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Bağlan, mesajları biriktir. */
  function client(token?: string) {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const msgs: QueueMessage[] = [];
    const waiters: (() => void)[] = [];
    ws.on('message', (d) => {
      msgs.push(JSON.parse(d.toString()) as QueueMessage);
      waiters.splice(0).forEach((w) => w());
    });
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    const opened = new Promise<void>((r) => ws.on('open', () => r()));
    if (token) void opened.then(() => ws.send(JSON.stringify({ type: 'auth', token })));
    const next = async (pred: (m: QueueMessage) => boolean, ms = 1000): Promise<QueueMessage> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = msgs.findIndex(pred);
        if (i >= 0) return msgs.splice(i, 1)[0]!;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`mesaj gelmedi: ${JSON.stringify(msgs)}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, left);
        });
      }
    };
    return { ws, msgs, next, closed, opened };
  }

  it('auth → ready + snapshot; yeni olay 1 sn içinde upsert; kapanınca remove', async () => {
    await deliver(sig('SOS', { protectedPersonId: 'pp-old' }));
    const worker = h.worker();
    await worker.drain(); // eski olayın outbox'ı istemci bağlanmadan boşalır
    const c = client(idp.token({ sub: 'op-1' }));
    expect(await c.next((m) => m.type === 'ready')).toMatchObject({ user: { sub: 'op-1', roles: ['OPERATOR'] } });
    const snap = (await c.next((m) => m.type === 'snapshot')) as Extract<QueueMessage, { type: 'snapshot' }>;
    expect(snap.total).toBe(1);

    const t0 = Date.now();
    await deliver(sig('SOS', { protectedPersonId: 'pp-new' }));
    await worker.drain(); // event.created / transitioned → bus → gateway
    const id = await idOf('pp-new');
    const up = (await c.next((m) => m.type === 'upsert' && (m.item as { eventId: string }).eventId === id)) as Extract<
      QueueMessage,
      { type: 'upsert' }
    >;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(up.item).toMatchObject({ eventId: id, type: 'SOS', state: 'OPERATOR_QUEUE' });

    await chain.claim(id, 'op-1');
    await worker.drain();
    expect(
      await c.next((m) => m.type === 'upsert' && (m.item as { lockedBy?: string }).lockedBy === 'op-1'),
    ).toBeTruthy();

    await chain.close(id, 'op-1', { outcome: 'FALSE_ALARM' });
    await worker.drain();
    expect(await c.next((m) => m.type === 'remove')).toEqual({ type: 'remove', eventId: id });
  });

  it('amir uyarısı (kilit doldu) yayınlanır', async () => {
    await deliver(sig('SOS', { protectedPersonId: 'pp-l' }));
    const id = await idOf('pp-l');
    const c = client(idp.token({ sub: 'sup-1', roles: ['SUPERVISOR'] }));
    await c.next((m) => m.type === 'snapshot');
    await chain.claim(id, 'op-1', new Date(Date.now() - 400_000));
    await events.releaseExpiredLocks();
    await h.worker().drain();
    expect(await c.next((m) => m.type === 'alert')).toMatchObject({
      alert: { code: 'O-LOCK-LOST', eventId: id, operatorId: 'op-1' },
    });
  });

  it('geçersiz token 4401, FAMILY 4403, bozuk mesaj 4400; kimliksiz istemci yayın almaz', async () => {
    expect(await client('bozuk').closed).toBe(4401);
    expect(await client(idp.token({ realm: 'consumers', roles: ['FAMILY'] })).closed).toBe(4403);
    const bad = client();
    await bad.opened;
    bad.ws.send('{');
    expect(await bad.closed).toBe(4400);

    const anon = client();
    await anon.opened;
    await deliver(sig('SOS', { protectedPersonId: 'pp-x' }));
    await h.worker().drain();
    await new Promise((r) => setTimeout(r, 100));
    expect(anon.msgs).toEqual([]);
  });

  it('yeniden bağlanınca tam liste', async () => {
    await deliver(sig('SOS', { protectedPersonId: 'pp-r1' }));
    await deliver(sig('SOS', { protectedPersonId: 'pp-r2' }));
    const a = client(idp.token());
    expect(((await a.next((m) => m.type === 'snapshot')) as { total: number }).total).toBe(2);
    a.ws.close();
    await a.closed;
    const b = client(idp.token());
    expect(((await b.next((m) => m.type === 'snapshot')) as { total: number }).total).toBe(2);
  });
});
