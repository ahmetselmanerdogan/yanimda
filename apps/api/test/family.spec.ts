import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { bus } from '../src/common/bus';
import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { signal } from '../src/db/schema';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { FAMILY_WS_PATH, FamilyGateway, type FamilyMessage } from '../src/modules/family/family.gateway';
import { FamilyService } from '../src/modules/family/family.service';
import { oidcConfigFromEnv, OidcVerifier } from '../src/modules/identity/oidc-verifier';
import { LearningService } from '../src/modules/learning/learning.service';
import type { Actor } from '../src/modules/profile/contacts';
import { ProfileService } from '../src/modules/profile/profile.service';
import { type FakeOidc, startFakeOidc } from './support/fake-oidc';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-061 aile uygulamasının API tarafı (C-04…C-10):
 *  - olaylar: liste ve ayrıntı (aşamalar, zincir adımları — numara/ad yok), kendi geri bildirimi; başka aile 404
 *  - koruma durumu aileye açık (yalnız kendi kişisi), konum paylaşımı açıksa son konum
 *  - ayarlar: düşme sorusu cevap süresi (30–90 sn) olay motoruna ve cihaz yapılandırmasına gider; konum paylaşımı
 *  - canlı: /v1/ws/family yalnız kendi kişilerinin olay değişikliklerini alır
 */
const ALICE: Actor = { kind: 'FAMILY', id: 'fam-alice' };
const BOB: Actor = { kind: 'FAMILY', id: 'fam-bob' };
const KEYS = `k1:${randomBytes(32).toString('base64')}`;

let h: Harness;
let idp: FakeOidc;
let profile: ProfileService;
let protection: ProtectionService;
let learning: LearningService;
let events: EventService;
let chain: ChainService;
let family: FamilyService;
beforeAll(async () => {
  h = await createHarness();
  idp = await startFakeOidc();
});
beforeEach(async () => {
  await h.reset();
  profile = new ProfileService(h.db, new FieldCipher(KEYS), undefined, null);
  protection = new ProtectionService(h.db, h.outbox);
  learning = new LearningService(h.db, h.outbox, profile);
  events = h.events(new InMemoryTimers());
  chain = new ChainService(h.db, events, loadProcedures());
  family = new FamilyService(h.db, profile);
});
afterAll(async () => {
  await idp.close();
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const person = async (who: Actor = ALICE) => (await profile.create(who, { displayName: 'Ayşe Y.' })).id;
const idOf = async (p: string) =>
  (await h.rows<{ id: string }>('SELECT id FROM event.event WHERE protected_person_id = $1 ORDER BY created_at', [p]))
    .map((r) => r.id)
    .at(-1)!;

describe('olaylar (C-06)', () => {
  it('liste yeniden eskiye; ayrıntıda aşama ve adımlar; numara ve ad yok', async () => {
    const p = await person();
    await profile.setContacts(ALICE, p, [
      { role: 'WATCH', phone: '+905550000005' },
      { role: 'CONTACT', displayName: 'Mehmet Y.', phone: '+905551112233' },
    ]);
    await deliver(sig('SOS', { protectedPersonId: p }));
    const id = await idOf(p);
    await chain.claim(id, 'op-1');
    await chain.call(id, 1, 'op-1');
    await chain.stepResult(id, 1, 'op-1', { result: 'NO_ANSWER' });

    const list = await family.events(ALICE, p);
    expect(list.items).toEqual([
      expect.objectContaining({ id, type: 'SOS', state: 'CONTACT_CHAIN', isTest: false, closedAt: null }),
    ]);
    const d = await family.event(ALICE, p, id);
    expect(d).toMatchObject({ id, stage: 'CALLING', outcome: null, operatorNote: null, feedback: null });
    expect(d.steps[0]).toMatchObject({ n: 1, kind: 'CALL_WATCH', status: 'DONE', result: 'NO_ANSWER' });
    expect(d.steps.find((s) => s.kind === 'CALL_CONTACT')).toMatchObject({ contactIndex: 1, status: 'PENDING' });
    const json = JSON.stringify(d);
    expect(json).not.toContain('5551112233');
    expect(json).not.toContain('Mehmet');
    expect(json).not.toContain('op-1');

    await expect(family.event(BOB, p, id)).rejects.toMatchObject({ status: 404 });
    await expect(family.events(BOB, p)).rejects.toMatchObject({ status: 404 });
    const other = await person(BOB);
    await expect(family.event(ALICE, other, id)).rejects.toMatchObject({ status: 404 });
  });

  it('kapanan olay: sonuç, geri bildirim alanı; test olayında operatör notu', async () => {
    const p = await person();
    await deliver(sig('SOS', { protectedPersonId: p }));
    const id = await idOf(p);
    await chain.claim(id, 'op-1');
    await chain.close(id, 'op-1', { outcome: 'FALSE_ALARM', note: 'Yanlışlıkla basmış' });
    const d = await family.event(ALICE, p, id);
    expect(d).toMatchObject({ stage: 'CLOSED', outcome: 'FALSE_ALARM', operatorNote: null, canFeedback: true });
    await h.pg.query(`INSERT INTO event.family_feedback (event_id, subject, real, at) VALUES ($1, $2, false, now())`, [
      id,
      ALICE.id,
    ]);
    expect(await family.event(ALICE, p, id)).toMatchObject({ feedback: { real: false }, canFeedback: false });

    const t = { id: (await events.requestTest(p, 'family-test-1')).eventId };
    await chain.claim(t.id, 'op-1');
    await chain.close(t.id, 'op-1', { outcome: 'TEST', note: 'Kurulum tamam' });
    expect(await family.event(ALICE, p, t.id)).toMatchObject({
      isTest: true,
      stage: 'CLOSED',
      operatorNote: 'Kurulum tamam',
      canFeedback: false,
    });
    expect((await family.events(ALICE, p)).items.map((e) => e.id)).toEqual([t.id, id]);
  });
});

describe('koruma durumu ve konum (C-08)', () => {
  it('aile yalnız kendi kişisini görür; konum paylaşımı kapalıysa konum yok', async () => {
    const p = await person();
    expect(await protection.canFamilySee('fam-alice', p)).toBe(true);
    expect(await protection.canFamilySee('fam-bob', p)).toBe(false);
    await h.db.insert(signal).values({
      time: new Date(),
      deviceId: 'w1',
      protectedPersonId: p,
      kind: 'LOCATION',
      value: null,
      payload: { location: { lat: 41.01, lng: 28.97, accuracyM: 20 } },
      idempotencyKey: `loc:${p}`,
    });
    expect((await protection.locationOf(p))!).toMatchObject({ lat: 41.01, lng: 28.97 });
    // Bulgu 14: daha yeni ama konumu null sinyal son bilinen konumu gizlemez.
    await h.db.insert(signal).values({
      time: new Date(Date.now() + 1000),
      deviceId: 'w1',
      protectedPersonId: p,
      kind: 'HEARTBEAT',
      value: null,
      payload: { location: null },
      idempotencyKey: `hb:${p}`,
    });
    expect((await protection.locationOf(p))!).toMatchObject({ lat: 41.01, lng: 28.97 });
    await profile.update(ALICE, p, { locationSharing: false });
    expect(await protection.locationOf(p)).toBeNull();
    expect((await profile.get(ALICE, p)).locationSharing).toBe(false);
  });
});

describe('ayarlar (C-09)', () => {
  it('düşme sorusu cevap süresi 30–90 sn: olay penceresi ve cihaz yapılandırması; null varsayılana döner', async () => {
    const p = await person();
    await expect(learning.setThresholds(ALICE, p, { fallPromptSec: 20 })).rejects.toMatchObject({ status: 400 });
    await expect(learning.setThresholds(ALICE, p, { fallPromptSec: 120 })).rejects.toMatchObject({ status: 400 });
    const s = await learning.setThresholds(ALICE, p, { fallPromptSec: 45 });
    expect(s).toMatchObject({ fallPromptSec: 45 });
    expect((await protection.settingsOf(p)).fallPromptSec).toBe(45);

    const t0 = Date.now();
    await deliver(sig('FALL', { protectedPersonId: p }));
    const [ev] = await h.rows<{ device_prompt_until: Date }>(
      'SELECT device_prompt_until FROM event.event WHERE protected_person_id = $1',
      [p],
    );
    const win = (new Date(ev!.device_prompt_until).getTime() - t0) / 1000;
    expect(win).toBeGreaterThan(44);
    expect(win).toBeLessThan(47);

    expect(await learning.setThresholds(ALICE, p, { fallPromptSec: null })).toMatchObject({ fallPromptSec: null });
    expect((await protection.settingsOf(p)).fallPromptSec).toBeNull();
  });
});

describe('canlı /v1/ws/family', () => {
  let server: Server;
  let gw: FamilyGateway;
  let url: string;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${FAMILY_WS_PATH}`;
    gw = new FamilyGateway(family, new OidcVerifier(oidcConfigFromEnv(idp.env)), undefined);
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
    const msgs: FamilyMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as FamilyMessage));
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    return { msgs, closed };
  }
  const until = async (pred: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('zaman aşımı');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("aile kendi kişisinin olayını canlı alır, başkasınınkini almaz; operasyon token'ı 4403", async () => {
    const mine = await person(ALICE);
    const theirs = await person(BOB);
    const fam = (sub: string) => idp.token({ realm: 'consumers', roles: ['FAMILY'], sub });
    const a = client(fam('fam-alice'));
    await until(() => a.msgs.some((m) => m.type === 'ready'));
    expect(a.msgs.find((m) => m.type === 'ready')).toMatchObject({ persons: [mine] });

    await deliver(sig('SOS', { protectedPersonId: theirs }));
    await deliver(sig('SOS', { protectedPersonId: mine }));
    await h.worker().drain();
    const id = await idOf(mine);
    await until(() => a.msgs.some((m) => m.type === 'event' && m.event.id === id));
    const ev = a.msgs.find((m) => m.type === 'event' && m.event.id === id) as Extract<FamilyMessage, { type: 'event' }>;
    expect(ev.event).toMatchObject({ protectedPersonId: mine, type: 'SOS', stage: 'QUEUED' });
    expect(
      a.msgs.filter((m) => m.type === 'event').every((m) => m.type === 'event' && m.event.protectedPersonId === mine),
    ).toBe(true);

    await chain.claim(id, 'op-1');
    await h.worker().drain();
    await until(() => a.msgs.some((m) => m.type === 'event' && m.event.stage === 'OPERATOR'));

    expect(await client(idp.token({ sub: 'op-1' })).closed).toBe(4403);
  });

  it('aileden çıkarılan hesap açık bağlantısında artık olay almaz (T-040)', async () => {
    const p = await person(ALICE);
    const a = client(idp.token({ realm: 'consumers', roles: ['FAMILY'], sub: 'fam-alice' }));
    await until(() => a.msgs.some((m) => m.type === 'ready'));
    // Bağlantı açıkken üyelik kalkar (sahip çıkardı / kendisi ayrıldı).
    await h.exec.exec(`DELETE FROM profile.family_member WHERE subject = 'fam-alice'`);
    await deliver(sig('SOS', { protectedPersonId: p }));
    await h.worker().drain();
    await new Promise((r) => setTimeout(r, 300));
    expect(a.msgs.filter((m) => m.type === 'event')).toEqual([]);
  });
});
