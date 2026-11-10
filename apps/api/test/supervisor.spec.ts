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
import { SupervisorService } from '../src/modules/metrics/supervisor.service';
import { QUEUE_WS_PATH, QueueGateway, type QueueMessage } from '../src/modules/queue/queue.gateway';
import { type FakeOidc, startFakeOidc } from './support/fake-oidc';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-074 amir panosu (E-11). Kabul: ihlal üretilince listede 5 sn içinde (konsol Playwright; burada WS itme aralığı).
 *  - 24 saat kuyruk derinliği (saatlik), olay dağılımı, operatör kartları (durum, açık olay, ortalama üstlenme)
 *  - SLA ihlalleri: kuyrukta bekleyen (canlı) ve geçmiş üstlenme / ilk arama ihlalleri
 *  - eylemler: operatör durumu, yedek merkeze taşma bayrağı (v2.0'da gerçek), unclaim (queue.spec)
 *  - WS: amire 5 sn'de bir `dashboard`; operatöre gitmez; operatör bağlantısı "görüldü" yazar
 */
let h: Harness;
let idp: FakeOidc;
let events: EventService;
let chain: ChainService;
let sup: SupervisorService;
beforeAll(async () => {
  h = await createHarness();
  idp = await startFakeOidc();
});
beforeEach(async () => {
  await h.reset();
  events = h.events(new InMemoryTimers());
  chain = new ChainService(h.db, events, loadProcedures());
  sup = new SupervisorService(h.db);
});
afterAll(async () => {
  await idp.close();
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const idOf = async (person: string) =>
  (await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1', [person]))[0]!.id;
const later = (sec: number) => new Date(Date.now() + sec * 1000);
/** Olay motoru geçişleri gerçek saatle yazar; üstlenme anını testte ileri al. */
const claimAt = async (id: string, operatorId: string, sec: number) => {
  await chain.claim(id, operatorId, later(sec));
  await h.pg.query(
    `UPDATE event.transition SET at = at + make_interval(secs => $2) WHERE event_id = $1 AND to_state = 'OPERATOR_ASSIGNED'`,
    [id, sec],
  );
};

describe('pano içeriği', () => {
  it('24 saat kuyruk derinliği (24 saatlik nokta), olay dağılımı; test olayı sayılmaz', async () => {
    await deliver(sig('SOS', { protectedPersonId: 'pp-1' }));
    await deliver(sig('SOS', { protectedPersonId: 'pp-2' }));
    await deliver(sig('CALLBACK_REQUEST', { protectedPersonId: 'pp-3' }));
    await deliver(sig('TEST', { protectedPersonId: 'pp-t' }));
    await chain.claim(await idOf('pp-1'), 'op-1');

    const d = await sup.dashboard();
    expect(d.queueDepth24h).toHaveLength(24);
    const last = d.queueDepth24h.at(-1)!;
    expect(last).toMatchObject({ depth: 2, entered: 3 }); // pp-2 + pp-3 bekliyor; pp-1 girdi ve çıktı
    expect(d.queueDepth24h.slice(0, -1).every((p) => p.depth === 0 && p.entered === 0)).toBe(true);
    expect(new Date(last.at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(d.byType24h).toEqual({ SOS: 2, CALLBACK: 1 });
  });

  it('operatör kartları: durum, bağlı mı, açık olaylar, 24 saat üstlenme ortalaması ve kapanan', async () => {
    await deliver(sig('SOS', { protectedPersonId: 'pp-a' }));
    await deliver(sig('SOS', { protectedPersonId: 'pp-b' }));
    const a = await idOf('pp-a');
    const b = await idOf('pp-b');
    await sup.seen('op-1', 'Ayşe Operatör');
    await claimAt(a, 'op-1', 4);
    await claimAt(b, 'op-2', 6);
    await chain.close(b, 'op-2', { outcome: 'FALSE_ALARM' });
    await sup.setStatus('op-2', 'BREAK', 'sup-1');

    const d = await sup.dashboard(later(10));
    const op1 = d.operators.find((o) => o.subject === 'op-1')!;
    const op2 = d.operators.find((o) => o.subject === 'op-2')!;
    expect(op1).toMatchObject({ name: 'Ayşe Operatör', status: 'AVAILABLE', online: true, claims24h: 1, closed24h: 0 });
    expect(op1.avgClaimSec).toBeGreaterThanOrEqual(3);
    expect(op1.avgClaimSec).toBeLessThan(6);
    expect(op1.open).toEqual([
      { eventId: a, type: 'SOS', priority: 1, state: 'OPERATOR_ASSIGNED', since: expect.any(String) },
    ]);
    expect(op2).toMatchObject({ name: null, status: 'BREAK', online: false, claims24h: 1, closed24h: 1, open: [] });
    // Bağlı operatör önce, sonra ad/kimlik sırası.
    expect(d.operators.map((o) => o.subject)).toEqual(['op-1', 'op-2']);

    const stale = await sup.dashboard(later(200)); // 90 sn'den eski "görüldü" → bağlı değil
    expect(stale.operators.find((o) => o.subject === 'op-1')!.online).toBe(false);
  });

  it('SLA ihlalleri: kuyrukta 10 sn+ bekleyen (canlı), geç üstlenme ve geç ilk arama; test olayı yok', async () => {
    await deliver(sig('SOS', { protectedPersonId: 'pp-wait' }));
    await deliver(sig('SOS', { protectedPersonId: 'pp-slow' }));
    await deliver(sig('SOS', { protectedPersonId: 'pp-ok' }));
    await deliver(sig('TEST', { protectedPersonId: 'pp-test' }));
    const wait = await idOf('pp-wait');
    const slow = await idOf('pp-slow');
    const ok = await idOf('pp-ok');
    await claimAt(slow, 'op-1', 15); // 15 sn > 10 sn SLA
    await claimAt(ok, 'op-2', 2);
    await chain.call(ok, 1, 'op-2', later(30)); // üstlenmeden 28 sn sonra ilk arama > 20 sn

    const fresh = await sup.dashboard(later(5));
    expect(fresh.slaBreaches.filter((x) => x.live)).toEqual([]);

    const d = await sup.dashboard(later(40));
    const byEvent = (id: string) => d.slaBreaches.filter((x) => x.eventId === id);
    expect(byEvent(wait)).toEqual([
      expect.objectContaining({ kind: 'CLAIM', live: true, type: 'SOS', priority: 1, operatorId: null }),
    ]);
    expect(byEvent(wait)[0]!.waitedSec).toBeGreaterThanOrEqual(39);
    expect(byEvent(slow)).toEqual([
      // ilk arama hiç yapılmadı ve üstlenmeden 25 sn geçti → canlı (canlılar önce)
      expect.objectContaining({ kind: 'FIRST_CALL', live: true, operatorId: 'op-1' }),
      expect.objectContaining({ kind: 'CLAIM', live: false, operatorId: 'op-1' }),
    ]);
    expect(byEvent(slow).find((x) => x.kind === 'CLAIM')!.waitedSec).toBeGreaterThanOrEqual(14);
    expect(byEvent(ok)).toEqual([expect.objectContaining({ kind: 'FIRST_CALL', live: false, operatorId: 'op-2' })]);
    expect(d.slaBreaches.some((x) => x.eventId === undefined)).toBe(false);
    const testId = await idOf('pp-test');
    expect(byEvent(testId)).toEqual([]);
    // Canlı ihlaller önce.
    const firstPast = d.slaBreaches.findIndex((x) => !x.live);
    expect(d.slaBreaches.slice(firstPast).every((x) => !x.live)).toBe(true);
    expect(d.sla).toEqual({ claimSec: 10, firstCallSec: 20 });
  });
});

describe('gelen SOS aramaları (bulgu 8)', () => {
  const insertCall = (id: string, status: string, person: string | null, at: Date) =>
    h.pg.query(
      `INSERT INTO telephony.inbound_call (id, provider, provider_call_id, protected_person_id, status, queued_at, created_at)
       VALUES ($1::uuid, 'fake', $1::text, $2, $3, $4, $5)`,
      [id, person, status, status === 'queued' ? at : null, at],
    );

  it('kuyruktaki ve çalan aramalar panoda; kişi adı var, numara yok; bitenler yok', async () => {
    const now = new Date();
    const person = '01960000-0000-7000-8000-0000000000f1';
    await h.pg.query("INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Ayşe Y.')", [person]);
    await insertCall('01960000-0000-7000-8000-0000000000e1', 'queued', person, new Date(now.getTime() - 45_000));
    await insertCall('01960000-0000-7000-8000-0000000000e2', 'queued', null, new Date(now.getTime() - 10_000));
    await insertCall('01960000-0000-7000-8000-0000000000e3', 'ringing', null, now);
    await insertCall('01960000-0000-7000-8000-0000000000e4', 'completed', null, now);
    const d = await sup.dashboard(now);
    expect(d.inbound).toMatchObject({ queued: 2, ringing: 1, oldestQueuedSec: 45 });
    expect(d.inbound.calls.map((c) => [c.status, c.person])).toEqual([
      ['queued', 'Ayşe Y.'],
      ['queued', null],
      ['ringing', null],
    ]);
    expect(JSON.stringify(d.inbound)).not.toMatch(/\+90|phone/i);
  });
});

describe('eylemler', () => {
  it('operatör durumu: geçerli değerler, audit; geçersiz 400', async () => {
    const r = await sup.setStatus('op-9', 'OFFLINE', 'sup-1');
    expect(r).toMatchObject({ subject: 'op-9', status: 'OFFLINE', statusBy: 'sup-1' });
    await expect(sup.setStatus('op-9', 'LUNCH', 'sup-1')).rejects.toMatchObject({ status: 400 });
    await expect(sup.setStatus('', 'BREAK', 'sup-1')).rejects.toMatchObject({ status: 400 });
    const audit = await h.rows<{ action: string; actor_id: string; data: unknown }>(
      "SELECT action, actor_id, data FROM audit.log WHERE entity_id = 'op-9' ORDER BY id",
    );
    expect(audit).toEqual([{ action: 'operator.status', actor_id: 'sup-1', data: { status: 'OFFLINE' } }]);
    // Bağlanınca durum değişmez (amirin kararı kalır), ad güncellenir.
    await sup.seen('op-9', 'Mehmet');
    expect((await sup.dashboard()).operators[0]).toMatchObject({ subject: 'op-9', status: 'OFFLINE', name: 'Mehmet' });
  });

  it('yedek merkeze taşma bayrağı: kapalı başlar, açılır, audit', async () => {
    expect((await sup.dashboard()).overflow).toEqual({ enabled: false, changedAt: null, changedBy: null });
    await sup.setOverflow(true, 'sup-1');
    expect((await sup.dashboard()).overflow).toMatchObject({ enabled: true, changedBy: 'sup-1' });
    await expect(sup.setOverflow('evet' as unknown as boolean, 'sup-1')).rejects.toMatchObject({ status: 400 });
    const audit = await h.rows<{ action: string; data: unknown }>(
      "SELECT action, data FROM audit.log WHERE action = 'supervisor.overflow'",
    );
    expect(audit).toEqual([{ action: 'supervisor.overflow', data: { enabled: true } }]);
  });
});

describe('WebSocket pano itmesi', () => {
  let server: Server;
  let gw: QueueGateway;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${QUEUE_WS_PATH}`;
    gw = new QueueGateway(events, new OidcVerifier(oidcConfigFromEnv(idp.env)), undefined, undefined, sup, {
      SUPERVISOR_PUSH_MS: '100',
    });
    gw.attach(server, bus);
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await gw.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function client(token: string) {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const msgs: QueueMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as QueueMessage));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    return msgs;
  }
  const until = async (pred: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('zaman aşımı');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('operatöre kuyruktaki gelen arama sayısı: bağlanınca ve değişince (bulgu 8)', async () => {
    const opMsgs = client(idp.token({ sub: 'op-in', name: 'Zeynep' }));
    const inbound = () => opMsgs.filter((m) => m.type === 'inbound') as Extract<QueueMessage, { type: 'inbound' }>[];
    await until(() => inbound().length >= 1);
    expect(inbound()[0]).toMatchObject({ queued: 0 });
    await h.pg.query(
      `INSERT INTO telephony.inbound_call (id, provider, provider_call_id, status, queued_at)
       VALUES ('01960000-0000-7000-8000-0000000000e9', 'fake', 'x9', 'queued', now())`,
    );
    await until(() => inbound().some((m) => m.queued === 1));
  });

  it('amire bağlanınca ve aralıkla dashboard; operatöre gitmez; operatör "görüldü" olur', async () => {
    const opMsgs = client(idp.token({ sub: 'op-ws', name: 'Zeynep' }));
    const supMsgs = client(idp.token({ sub: 'sup-ws', roles: ['SUPERVISOR'], name: 'Amir Bey' }));
    const dashboards = () => supMsgs.filter((m) => m.type === 'dashboard');
    await until(() => dashboards().length >= 1);

    await deliver(sig('SOS', { protectedPersonId: 'pp-ws' }));
    const id = await idOf('pp-ws');
    await until(() =>
      dashboards().some((m) => m.type === 'dashboard' && m.dashboard.queue.some((q) => q.waiting === 1)),
    );
    expect(dashboards().length).toBeGreaterThanOrEqual(2);
    expect(opMsgs.some((m) => m.type === 'dashboard')).toBe(false);
    expect(opMsgs.some((m) => m.type === 'ready')).toBe(true);

    const card = (await sup.dashboard()).operators.find((o) => o.subject === 'op-ws');
    expect(card).toMatchObject({ name: 'Zeynep', online: true, status: 'AVAILABLE' });
    // Amir operatör kartı olmaz; olay üstlenirse adıyla görünür.
    expect((await sup.dashboard()).operators.some((o) => o.subject === 'sup-ws')).toBe(false);
    await chain.claim(id, 'sup-ws');
    expect((await sup.dashboard()).operators.find((o) => o.subject === 'sup-ws')).toMatchObject({
      name: 'Amir Bey',
      open: [{ eventId: id }],
    });
  });
});
