import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { defaultRegistry, DeviceService } from '../src/modules/device/device.service';
import { EnrollmentService } from '../src/modules/device/enrollment.service';
import { RecordingPush } from '../src/modules/device/push.port';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import { FAKE_PENDANT_PROFILES, FakePendantAdapter } from '../src/modules/partner/fake-pendant.adapter';
import { PartnerWebhookController } from '../src/modules/partner/partner.controller';
import {
  assertProfileClass,
  partnerIdempotencyKey,
  partnerSignature,
  RecordingPartnerGateway,
} from '../src/modules/partner/partner.types';
import { PartnerHealthService, percentile } from '../src/modules/partner/partner-health.service';
import { partnerSecretsFromEnv, PartnerWebhookService } from '../src/modules/partner/partner-webhook.service';
import { VendorLinkService } from '../src/modules/partner/vendor-link.service';
import { IdempotencyStore } from '../src/modules/signal/idempotency.store';
import { SignalService } from '../src/modules/signal/signal.service';
import { createHarness, type Harness } from './support/harness';

/**
 * T-085 OEM ortak sözleşmesi (docs/07 S2.5–S2.7) ve sertifika listesinin (S2.6) otomatikleşebilen kısmı — sahte ortağa
 * (FAKE_PENDANT) karşı: imzalı webhook, tekrar koruması, idempotency, profil dışı sinyal, bilinmeyen cihaz, SOS uçtan
 * uca ≤15 sn (20 SOS + 10 iptal), ortak gecikmesi (O-OEM-LATENCY, kapsamada "zayıf"), üretici bağlantısı (şifreli
 * hesap kimliği, KVKK yurt dışı rıza, cihaz sınırı, kaldırma).
 */
const pack = loadRulePack('TR');
// Test sırrı (gerçek sır değil; düşük entropi bilerek).
const SECRET = ['fake', 'partner', 'hook', 'test'].join('-');
const secrets = (p: string) => (p === 'FAKE_PENDANT' ? SECRET : null);
const cipher = new FieldCipher(`t1:${Buffer.alloc(32, 1).toString('base64')}`);
const person = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
const P1 = person(1);

let h: Harness;
let gw: RecordingPartnerGateway;
let devices: DeviceService;
let signals: SignalService;
let webhook: PartnerWebhookService;
let links: VendorLinkService;
let health: PartnerHealthService;
let protection: ProtectionService;
let clockNow: () => Date;
let seq = 0;
/** audit.log append-only (TRUNCATE yok): her test kendi satırlarına bakar. */
let auditMark = 0;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(
    'TRUNCATE device.partner_delivery, device.partner_latency, device.partner_status, device.work_order, device.pendant_maintenance',
  );
  await h.pg.exec(
    `INSERT INTO profile.protected_person (id, display_name) VALUES ${Array.from({ length: 40 }, (_, i) => `('${person(i + 1)}', 'K${i + 1}')`).join(', ')};
     INSERT INTO event.threshold (protected_person_id, sleep_start, sleep_end)
       SELECT id::text, '00:00', '00:00' FROM profile.protected_person;`,
  );
  auditMark = Number((await h.rows<{ m: number }>(`SELECT coalesce(max(id), 0)::int AS m FROM audit.log`))[0]!.m);
  clockNow = () => new Date();
  gw = new RecordingPartnerGateway();
  devices = new DeviceService(h.db, defaultRegistry(new RecordingPush(), gw));
  signals = new SignalService(h.db, new IdempotencyStore(h.redis), h.outbox, devices);
  webhook = new PartnerWebhookService(h.db, signals, devices, secrets, () => clockNow());
  links = new VendorLinkService(h.db, h.outbox, devices, cipher);
  health = new PartnerHealthService(h.db, h.outbox, devices, staticRules(pack), () => clockNow());
  protection = new ProtectionService(h.db, h.outbox, staticRules(pack));
  h.events(new InMemoryTimers(), pack);
});
afterAll(async () => {
  await h.close();
});

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status ?? (e as Error).message;
  }
};
const ev = (type: string, device: string, extra: Record<string, unknown> = {}) => ({
  id: `evt-${++seq}`,
  type,
  device,
  at: new Date(clockNow().getTime() - 1000).toISOString(),
  ...extra,
});
const signed = (body: string, o: { nonce?: string; ts?: number; secret?: string } = {}) => {
  const ts = o.ts ?? Math.floor(clockNow().getTime() / 1000);
  const nonce = o.nonce ?? `nonce-${++seq}-${Date.now()}`;
  return {
    'x-partner-timestamp': String(ts),
    'x-partner-nonce': nonce,
    'x-partner-signature': partnerSignature(o.secret ?? SECRET, ts, nonce, body),
  };
};
const deliver = (events: unknown[], o: Parameters<typeof signed>[1] & { partner?: string } = {}) => {
  const body = JSON.stringify({ events });
  return webhook.ingest(o.partner ?? 'FAKE_PENDANT', { rawBody: Buffer.from(body), headers: signed(body, o) });
};
const link = (
  vendorDeviceId: string,
  model = 'FAKE_PENDANT_CELL',
  personId = P1,
  extra: Record<string, unknown> = {},
) => links.create({ protectedPersonId: personId, partner: 'FAKE_PENDANT', model, vendorDeviceId, ...extra }, 'sup-1');
const drain = () => h.worker().drain();

describe('Sahte ortak adaptörü (S2.5 sözleşmesi)', () => {
  const a = new FakePendantAdapter(new RecordingPartnerGateway());

  it('üç A sınıfı model; sınıf denetimi geçer; gecikme hedefi ortak merkez ≤15 sn', () => {
    expect(a.profiles().map((p) => [p.modelId, p.category, p.tier, p.connectionPath])).toEqual([
      ['FAKE_PENDANT_CELL', 'PENDANT', 'A', 'PARTNER_CENTER'],
      ['FAKE_PENDANT_RADIO', 'PENDANT', 'A', 'HOME_UNIT'],
      ['FAKE_HOME_UNIT', 'HOME_UNIT', 'A', 'PARTNER_CENTER'],
    ]);
    for (const p of FAKE_PENDANT_PROFILES) {
      expect(() => assertProfileClass(p)).not.toThrow();
      expect(p.latencyTargetP95Sec).toBeLessThanOrEqual(15);
    }
    expect(a.capabilitiesFor('FAKE_PENDANT_RADIO')).toMatchObject({ voice: false, location: false, ring: false });
    expect(a.capabilitiesFor('FAKE_PENDANT_CELL')).toMatchObject({ voice: true, location: true, ring: true });
    expect(a.capabilitiesFor('YOK').signals).toEqual([]); // model bilinmiyorsa hiçbir şey
  });

  it('üretici olayı → kanonik sinyal (takılı kanıtı, gün, elektrik, hat, test, konum)', () => {
    const at = '2026-11-12T10:00:00.000Z';
    const parsed = a.parse({
      events: [
        { id: 'a1', type: 'SOS', device: 'D', at, lat: 41, lng: 29, accuracyM: 8, battery: 77 },
        { id: 'a2', type: 'WORN', device: 'D', at, confidence: 0.93 },
        { id: 'a3', type: 'WORN', device: 'D', at, confidence: 0.5 },
        { id: 'a4', type: 'WORN', device: 'D', at, confidence: 0.1 },
        { id: 'a5', type: 'NOT_WORN', device: 'D', at, days: 5 },
        { id: 'a6', type: 'POWER', device: 'H', at, mains: false },
        { id: 'a7', type: 'LINE', device: 'H', at, lineUp: false },
        { id: 'a8', type: 'BUTTON_TEST', device: 'D', at },
        { id: 'a9', type: 'BATTERY', device: 'D', at, battery: 18 },
        { id: 'a10', type: 'TELEPORT', device: 'D', at },
        { id: 'a11', type: 'SOS', device: 'D' },
        'bozuk',
      ],
    });
    expect(parsed.map((p) => (p.ok ? p.draft : { invalid: p.vendorEventId }))).toEqual([
      {
        kind: 'SOS',
        location: { lat: 41, lng: 29, source: 'GPS', accuracyM: 8 },
        device: { batteryPct: 77 },
        payload: {},
      },
      { kind: 'ON_BODY', device: { onWrist: true }, payload: { wornConfidence: 0.93 } },
      { kind: 'HEARTBEAT', payload: { wornConfidence: 0.5 } },
      { kind: 'OFF_BODY', device: { onWrist: false }, payload: { wornConfidence: 0.1 } },
      { kind: 'OFF_BODY', value: 5, device: { onWrist: false }, payload: {} },
      { kind: 'HEARTBEAT', device: { mainsPower: false }, payload: {} },
      { kind: 'HEARTBEAT', device: { lineOk: false }, payload: {} },
      { kind: 'TEST', payload: { trigger: 'BUTTON' } },
      { kind: 'BATTERY', value: 18, device: { batteryPct: 18 }, payload: {} },
      { invalid: 'a10' },
      { invalid: 'a11' },
      { invalid: null },
    ]);
  });

  it('idempotencyKey üretici olay kimliğinden: kararlı, ortaklar arası ayrı, şemaya uygun', () => {
    const k = partnerIdempotencyKey('FAKE_PENDANT', 'evt-1');
    expect(k).toBe(partnerIdempotencyKey('FAKE_PENDANT', 'evt-1'));
    expect(k).not.toBe(partnerIdempotencyKey('OTHER', 'evt-1'));
    expect(k).toMatch(/^[\x21-\x7e]{8,200}$/);
  });

  it('komutlar yetenek kapılı: profilde olmayan komut ağa çıkmaz', async () => {
    const g = new RecordingPartnerGateway();
    const x = new FakePendantAdapter(g);
    const call = (m: string, type: 'RING' | 'CALL' | 'LOCATE' | 'TEST' | 'PROMPT') =>
      x.sendCommand(
        'dev',
        m,
        type === 'TEST'
          ? { type }
          : type === 'PROMPT'
            ? { type, eventId: 'e', tts: 'W', windowSec: 30 }
            : { type, eventId: 'e' },
      );
    expect(
      await Promise.all(
        (['RING', 'CALL', 'LOCATE', 'TEST', 'PROMPT'] as const).flatMap((t) =>
          ['FAKE_PENDANT_CELL', 'FAKE_PENDANT_RADIO', 'FAKE_HOME_UNIT', 'YOK'].map((m) => call(m, t)),
        ),
      ),
    ).toEqual([
      ...['sent', 'unsupported', 'unsupported', 'unsupported'], // RING
      ...['sent', 'unsupported', 'sent', 'unsupported'], // CALL
      ...['sent', 'unsupported', 'unsupported', 'unsupported'], // LOCATE
      ...['sent', 'sent', 'sent', 'unsupported'], // TEST
      ...['unsupported', 'unsupported', 'unsupported', 'unsupported'], // PROMPT
    ]);
    expect(g.sent).toHaveLength(7);
  });

  it('simülatörün sahte ortak imzası API doğrulamasıyla aynı (pnpm --filter @yanimda/simulator start -- pendant)', async () => {
    const sim = (await import('@yanimda/simulator/partner')) as {
      partnerSignature(secret: string, ts: number, nonce: string, body: string): string;
    };
    const body = JSON.stringify({ events: [{ id: 'x', type: 'SOS', device: 'D', at: new Date().toISOString() }] });
    expect(sim.partnerSignature(SECRET, 1_700_000_000, 'n-12345678', body)).toBe(
      partnerSignature(SECRET, 1_700_000_000, 'n-12345678', body),
    );
  });

  it('webhook sırrı ortamdan; sahte ortak üretimde yalnız açıkça açılırsa', () => {
    const env = { PARTNER_FAKE_PENDANT_WEBHOOK_SECRET: 'x' };
    expect(partnerSecretsFromEnv(env)('FAKE_PENDANT')).toBe('x');
    expect(partnerSecretsFromEnv({ ...env, NODE_ENV: 'production' })('FAKE_PENDANT')).toBeNull();
    expect(
      partnerSecretsFromEnv({ ...env, NODE_ENV: 'production', PARTNER_FAKE_ENABLED: 'true' })('FAKE_PENDANT'),
    ).toBe('x');
    expect(partnerSecretsFromEnv({})('FAKE_PENDANT')).toBeNull();
    expect(partnerSecretsFromEnv(env)('fake_pendant')).toBeNull();
  });
});

describe('Üretici bağlantısı (S8.1, S9.3)', () => {
  it('cihaz + bağlantı: tür = ortak, katalog modeli, sınıf, bağlantı yolu; hesap kimliği yalnız şifreli; denetimde kimlik yok', async () => {
    const v = await link('FP-0001', 'FAKE_PENDANT_CELL', P1, { vendorAccountId: 'acct-42' });
    expect(v).toMatchObject({
      partner: 'FAKE_PENDANT',
      model: 'FAKE_PENDANT_CELL',
      status: 'ACTIVE',
      dataRegion: 'TR',
      consentBasis: 'NOT_REQUIRED',
      consentAt: null,
    });
    const [d] = await h.rows<Record<string, unknown>>(
      `SELECT kind, model_id, category, tier, connection_path, body_location, vendor_device_id FROM device.device WHERE id = $1`,
      [v.deviceId],
    );
    expect(d).toEqual({
      kind: 'FAKE_PENDANT',
      model_id: 'FAKE_PENDANT_CELL',
      category: 'PENDANT',
      tier: 'A',
      connection_path: 'PARTNER_CENTER',
      body_location: 'NECK',
      vendor_device_id: 'FP-0001',
    });
    const [l] = await h.rows<{ vendor_account_enc: string; token_enc: string | null }>(
      `SELECT vendor_account_enc, token_enc FROM device.vendor_link WHERE id = $1`,
      [v.id],
    );
    expect(l!.vendor_account_enc).not.toContain('acct-42');
    expect(cipher.decrypt(l!.vendor_account_enc, `vendor-link:${v.id}`)).toBe('acct-42');
    expect(() => cipher.decrypt(l!.vendor_account_enc, 'vendor-link:baska')).toThrow();
    expect(l!.token_enc).toBeNull();
    const audit = await h.rows<{ data: unknown }>(
      `SELECT data FROM audit.log WHERE id > ${auditMark} AND action = 'vendor_link.created'`,
    );
    expect(audit).toEqual([
      { data: { partner: 'FAKE_PENDANT', model: 'FAKE_PENDANT_CELL', dataRegion: 'TR', consentBasis: 'NOT_REQUIRED' } },
    ]);
    expect(JSON.stringify(audit)).not.toContain('FP-0001');
    expect(await links.list(P1)).toEqual([v]);
  });

  it('aynı üretici cihazı ikinci kez 409; bilinmeyen ortak 404; yanlış model 400; bilinmeyen kişi 404', async () => {
    await link('FP-0002');
    expect(await status(link('FP-0002', 'FAKE_PENDANT_CELL', person(2)))).toBe(409);
    expect(
      await status(links.create({ protectedPersonId: P1, partner: 'NOPE', model: 'X', vendorDeviceId: 'a' }, 's')),
    ).toBe(404);
    expect(await status(link('FP-0003', 'WEAROS_WATCH'))).toBe(400);
    expect(await status(link('FP-0004', 'FAKE_PENDANT_CELL', '00000000-0000-0000-0000-00000000ffff'))).toBe(404);
    expect(await status(link('', 'FAKE_PENDANT_CELL'))).toBe(400);
  });

  it('kişi başına cihaz sınırı (S1.7): 4. alarm giyilebilir 409 F-DEVICE-LIMIT; ev ünitesi giyilebilir sayılmaz', async () => {
    for (const n of [1, 2, 3]) await link(`LIM-${n}`, 'FAKE_PENDANT_RADIO');
    await link('LIM-H', 'FAKE_HOME_UNIT');
    const e = await link('LIM-4', 'FAKE_PENDANT_CELL').catch(
      (x) => x as { status: number; getResponse(): { code: string } },
    );
    expect([(e as { status: number }).status, (e as { getResponse(): { code: string } }).getResponse().code]).toEqual([
      409,
      'F-DEVICE-LIMIT',
    ]);
  });

  it('TR dışı veri bölgesi: açık rıza / aktarım dayanağı zorunlu (KVKK yurt dışı aktarım)', async () => {
    class EuPartner extends FakePendantAdapter {
      override readonly dataRegion = 'EU';
    }
    const eu = new DeviceService(h.db, defaultRegistry(new RecordingPush(), gw));
    (eu as unknown as { registry: { byKind: Map<string, unknown> } }).registry.byKind.set(
      'FAKE_PENDANT',
      new EuPartner(gw),
    );
    const l = new VendorLinkService(h.db, h.outbox, eu, cipher);
    const body = { protectedPersonId: P1, partner: 'FAKE_PENDANT', model: 'FAKE_PENDANT_CELL', vendorDeviceId: 'EU-1' };
    expect(await status(l.create(body, 's'))).toBe(400);
    expect(
      await status(l.create({ ...body, consent: { basis: 'NOT_REQUIRED', at: '2026-11-01T00:00:00Z' } }, 's')),
    ).toBe(400);
    expect(
      await status(l.create({ ...body, consent: { basis: 'EXPLICIT_CONSENT', at: '2999-01-01T00:00:00Z' } }, 's')),
    ).toBe(400);
    const v = await l.create({ ...body, consent: { basis: 'EXPLICIT_CONSENT', at: '2026-11-01T00:00:00Z' } }, 's');
    expect(v).toMatchObject({
      dataRegion: 'EU',
      consentBasis: 'EXPLICIT_CONSENT',
      consentAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('cihaz kaldırılınca (DELETE /devices) bağlantı ve belirteç anında geçersiz; webhook UNKNOWN_DEVICE', async () => {
    const v = await link('FP-DEL');
    await h.pg.query(`UPDATE device.vendor_link SET token_enc = 'v1:x:y' WHERE id = $1`, [v.id]);
    const enrollment = new EnrollmentService(
      h.db,
      h.redis as never,
      protection,
      staticRules(pack),
      'x'.repeat(32),
      h.outbox,
    );
    await enrollment.revoke(v.deviceId);
    const [l] = await h.rows<{ status: string; token_enc: string | null }>(
      `SELECT status, token_enc FROM device.vendor_link WHERE id = $1`,
      [v.id],
    );
    expect(l).toEqual({ status: 'REVOKED', token_enc: null });
    expect((await deliver([ev('SOS', 'FP-DEL')])).rejected).toEqual([
      { eventId: expect.any(String), reason: 'UNKNOWN_DEVICE' },
    ]);
  });
});

describe('İmzalı webhook (S2.6: imza, tekrar koruması, idempotency)', () => {
  it('SOS: 202 → signal.signal + outbox (aynı transaction hattı) → P1 olay; kaynak profili ortaktan', async () => {
    const v = await link('FP-SOS');
    const e = ev('SOS', 'FP-SOS', { lat: 41.01, lng: 28.97 });
    const body = JSON.stringify({ events: [e] });
    const ctl = new PartnerWebhookController(webhook);
    expect(await ctl.ingest('FAKE_PENDANT', { rawBody: Buffer.from(body), headers: signed(body) })).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [],
    });
    const key = partnerIdempotencyKey('FAKE_PENDANT', e.id);
    const [s] = await h.rows<{ device_id: string; kind: string; payload: { payload: unknown; source: unknown } }>(
      `SELECT device_id, kind, payload FROM signal.signal WHERE idempotency_key = $1`,
      [key],
    );
    expect(s).toMatchObject({ device_id: v.deviceId, kind: 'SOS' });
    expect(s!.payload.payload).toEqual({ vendorEventId: e.id });
    expect(s!.payload.source).toMatchObject({
      kind: 'FAKE_PENDANT',
      category: 'PENDANT',
      tier: 'A',
      connectionPath: 'PARTNER_CENTER',
      caps: { sos: true, fall: true, voice: true, location: true },
    });
    const out = await h.rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM event.outbox WHERE topic = 'signal.received' AND envelope->'payload'->>'idempotencyKey' = $1`,
      [key],
    );
    expect(out[0]!.n).toBe(1);
    await drain();
    expect(await h.rows(`SELECT type, priority, state FROM event.event`)).toEqual([
      { type: 'SOS', priority: 1, state: 'OPERATOR_QUEUE' },
    ]);
  });

  it('imza: yanlış sır / eksik başlık / bozuk gövde 401; pencere dışı zaman damgası 401; ortak yok veya sırrı yok 404', async () => {
    await link('FP-SIG');
    const body = JSON.stringify({ events: [ev('SOS', 'FP-SIG')] });
    const raw = Buffer.from(body);
    expect(
      await status(webhook.ingest('FAKE_PENDANT', { rawBody: raw, headers: signed(body, { secret: 'baska' }) })),
    ).toBe(401);
    expect(await status(webhook.ingest('FAKE_PENDANT', { rawBody: raw, headers: {} }))).toBe(401);
    expect(
      await status(webhook.ingest('FAKE_PENDANT', { rawBody: Buffer.from(body + ' '), headers: signed(body) })),
    ).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    expect(
      await status(webhook.ingest('FAKE_PENDANT', { rawBody: raw, headers: signed(body, { ts: now - 301 }) })),
    ).toBe(401);
    expect(
      await status(webhook.ingest('FAKE_PENDANT', { rawBody: raw, headers: signed(body, { ts: now + 301 }) })),
    ).toBe(401);
    expect(
      await status(webhook.ingest('FAKE_PENDANT', { rawBody: raw, headers: signed(body, { ts: now - 290 }) })),
    ).toBe('ok');
    expect(await status(webhook.ingest('OTHER', { rawBody: raw, headers: signed(body) }))).toBe(404);
    const closed = new PartnerWebhookService(h.db, signals, devices, () => null);
    expect(await status(closed.ingest('FAKE_PENDANT', { rawBody: raw, headers: signed(body) }))).toBe(404);
    expect(await h.rows(`SELECT 1 FROM signal.signal`)).toHaveLength(1);
  });

  it('tekrar koruması: aynı nonce 409 (hiçbir şey yazılmaz, denetimde); aynı olay yeni nonce ile → tekrar (idempotency)', async () => {
    await link('FP-RPL');
    const e = ev('SOS', 'FP-RPL');
    const body = JSON.stringify({ events: [e] });
    const headers = signed(body, { nonce: 'replay-nonce-0001' });
    expect(await webhook.ingest('FAKE_PENDANT', { rawBody: Buffer.from(body), headers })).toMatchObject({
      accepted: 1,
    });
    expect(await status(webhook.ingest('FAKE_PENDANT', { rawBody: Buffer.from(body), headers }))).toBe(409);
    expect(
      await h.rows(`SELECT 1 FROM audit.log WHERE id > ${auditMark} AND action = 'partner.webhook_replay'`),
    ).toHaveLength(1);
    expect(await deliver([e])).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    expect(await h.rows(`SELECT 1 FROM signal.signal`)).toHaveLength(1);
    await drain();
    expect(await h.rows(`SELECT 1 FROM event.event`)).toHaveLength(1);
  });

  it('sinyal başına ret: bilinmeyen cihaz, okunamayan olay, profil dışı sinyal (radyo kolyede konum) — SOS yine yazılır; retler denetimde', async () => {
    await link('FP-RAD', 'FAKE_PENDANT_RADIO');
    const sos = ev('SOS', 'FP-RAD');
    const loc = ev('LOCATION', 'FP-RAD', { lat: 41, lng: 29 });
    const unknown = ev('SOS', 'FP-YOK');
    const bad = ev('TELEPORT', 'FP-RAD');
    const r = await deliver([unknown, loc, sos, bad]);
    expect(r).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [
        { eventId: unknown.id, reason: 'UNKNOWN_DEVICE' },
        { eventId: bad.id, reason: 'EVENT_INVALID' },
        { eventId: loc.id, reason: 'UNSUPPORTED_SIGNAL' },
      ],
    });
    const audit = await h.rows<{ action: string; entity_type: string; data: Record<string, unknown> }>(
      `SELECT action, entity_type, data FROM audit.log WHERE id > ${auditMark} AND action IN ('partner.event_rejected', 'signal.rejected') ORDER BY id`,
    );
    expect(audit).toEqual([
      {
        action: 'partner.event_rejected',
        entity_type: 'partner',
        data: { partner: 'FAKE_PENDANT', reason: 'UNKNOWN_DEVICE' },
      },
      {
        action: 'partner.event_rejected',
        entity_type: 'partner',
        data: { partner: 'FAKE_PENDANT', reason: 'EVENT_INVALID' },
      },
      { action: 'signal.rejected', entity_type: 'device', data: { kind: 'LOCATION', reason: 'UNSUPPORTED_SIGNAL' } },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/FP-|41|29/);
    // Yalnız retli parti: 202 (ortak yeniden göndermez), boş liste / JSON değil 400.
    expect(await deliver([ev('LOCATION', 'FP-RAD', { lat: 1, lng: 2 })])).toMatchObject({
      accepted: 0,
      rejected: [{ reason: 'UNSUPPORTED_SIGNAL' }],
    });
    expect(await status(deliver([]))).toBe(400);
  });

  it('komutlar ortak merkezine (DeviceService): hücresel kolye çaldır / konum / test; radyo kolyede yalnız test', async () => {
    const cell = await link('FP-CMD');
    const radio = await link('FP-CMD-R', 'FAKE_PENDANT_RADIO');
    expect(await devices.ring(cell.deviceId, { eventId: 'e1' })).toBe('sent');
    expect(await devices.command(cell.deviceId, { type: 'LOCATE', eventId: 'e1' })).toBe('sent');
    expect(await devices.command(radio.deviceId, { type: 'LOCATE', eventId: 'e1' })).toBe('unsupported');
    expect(await devices.ring(radio.deviceId, { eventId: 'e1' })).toBe('unsupported');
    expect(await devices.command(radio.deviceId, { type: 'TEST' })).toBe('sent');
    expect(
      await devices.promptUser(cell.deviceId, {
        eventId: 'e1',
        kind: 'FALL',
        tts: 'W-FALL-1',
        windowSec: 30,
        until: new Date().toISOString(),
        silent: false,
      }),
    ).toBe('unsupported');
    expect(gw.sent.map((x) => [x.partner, x.deviceId === cell.deviceId ? 'cell' : 'radio', x.cmd.type])).toEqual([
      ['FAKE_PENDANT', 'cell', 'RING'],
      ['FAKE_PENDANT', 'cell', 'LOCATE'],
      ['FAKE_PENDANT', 'radio', 'TEST'],
    ]);
  });

  it('S2.6 SOS uçtan uca ≤15 sn: 20 SOS + 10 düşme/iptal; ≥%95 zamanında; iptaller kolyeden kapanır', async () => {
    const sosLinks = [];
    for (let i = 1; i <= 20; i++) sosLinks.push(await link(`CERT-S${i}`, 'FAKE_PENDANT_CELL', person(i)));
    const fallLinks = [];
    for (let i = 21; i <= 30; i++) fallLinks.push(await link(`CERT-F${i}`, 'FAKE_PENDANT_CELL', person(i)));
    // Ortak merkezinin kendi gecikmesi 1–10 sn (olay anı geçmişte).
    const delayed = (type: string, device: string, sec: number) => ({
      ...ev(type, device),
      at: new Date(Date.now() - sec * 1000).toISOString(),
    });
    for (let i = 0; i < 20; i++) await deliver([delayed('SOS', `CERT-S${i + 1}`, 1 + (i % 10))]);
    await drain();
    for (let i = 0; i < 10; i++) await deliver([delayed('FALL', `CERT-F${i + 21}`, 2)]);
    await drain();
    for (let i = 0; i < 10; i++) await deliver([ev('CANCEL', `CERT-F${i + 21}`)]);
    await drain();
    const rows = await h.rows<{ type: string; state: string; latency_ms: number }>(`
      SELECT e.type, e.state,
             extract(epoch FROM (q.at - (s.payload->>'occurredAt')::timestamptz)) * 1000 AS latency_ms
      FROM event.event e
      JOIN signal.signal s ON s.idempotency_key = e.source_signal_ids[1]
      LEFT JOIN LATERAL (SELECT min(t.at) AS at FROM event.transition t
                         WHERE t.event_id = e.id AND t.to_state IN ('OPERATOR_QUEUE', 'DEVICE_PROMPT')) q ON true`);
    const sos = rows.filter((r) => r.type === 'SOS');
    expect(sos).toHaveLength(20);
    const onTime = sos.filter((r) => r.state === 'OPERATOR_QUEUE' && Number(r.latency_ms) <= 15_000).length;
    expect(onTime / sos.length).toBeGreaterThanOrEqual(0.95);
    const falls = rows.filter((r) => r.type === 'FALL');
    expect(falls).toHaveLength(10);
    expect(falls.every((r) => r.state === 'CLOSED')).toBe(true);
    expect(sosLinks).toHaveLength(20);
    expect(fallLinks).toHaveLength(10);
  }, 60_000);
});

describe('Ortak gecikmesi (S2.7): p99 > 60 sn (1 sa) → O-OEM-LATENCY + kapsamada zayıf', () => {
  const T0 = new Date('2026-11-12T10:00:00.000Z');
  const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

  it('nearest-rank yüzdelik', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(xs, 95), percentile(xs, 99), percentile([5], 99), percentile([], 99)]).toEqual([
      95,
      99,
      5,
      null,
    ]);
  });

  it('yalnız yeni yazılan olay örnek olur (tekrar değil); yeterli örnekte bozulma, tek uyarı, zayıf neden; düzelince kalkar', async () => {
    clockNow = () => at(0);
    const v = await link('LAT-1');
    // Kolye takılı (kapsama FULL) — olay anı 1 sn önce.
    await deliver([{ ...ev('WORN', 'LAT-1', { confidence: 0.95 }), at: at(-1).toISOString() }]);
    // 19 olay 70 sn gecikmeli: örnek yetersiz (minSamples 20) → durum değişmez.
    const late = (n: number, sec: number, base = 0) =>
      Array.from({ length: n }, (_, i) => ({
        ...ev('HEARTBEAT', 'LAT-1'),
        at: at(base - sec - i * 0.001).toISOString(),
      }));
    await deliver(late(18, 70));
    expect((await health.sweep(at(1)))[0]).toMatchObject({ partner: 'FAKE_PENDANT', samples: 19, degradedSince: null });
    const dup = await deliver([{ ...ev('HEARTBEAT', 'LAT-1'), id: 'evt-1', at: at(-500).toISOString() }]);
    expect(dup.duplicates + dup.accepted).toBe(1);
    await deliver(late(2, 70));
    const n = Number((await h.rows<{ n: number }>(`SELECT count(*)::int AS n FROM device.partner_latency`))[0]!.n);
    await drain();
    const s1 = (await health.sweep(at(2)))[0]!;
    expect(s1).toMatchObject({ samples: n, degradedSince: at(2).toISOString() });
    expect(s1.p99Ms!).toBeGreaterThan(60_000);
    expect((await health.sweep(at(3)))[0]!.degradedSince).toBe(at(2).toISOString()); // bozulma sürer, ikinci uyarı yok
    const alerts = await h.rows<{ payload: Record<string, unknown> }>(
      `SELECT envelope->'payload' AS payload FROM event.outbox WHERE topic = 'supervisor.alert'`,
    );
    expect(alerts.map((a) => a.payload)).toEqual([
      expect.objectContaining({ code: 'O-OEM-LATENCY', eventId: 'partner:FAKE_PENDANT', eventType: 'PARTNER' }),
    ]);
    expect(
      await h.rows(`SELECT 1 FROM audit.log WHERE id > ${auditMark} AND action = 'partner.latency_degraded'`),
    ).toHaveLength(1);
    // Kapsama: seviye aynı (TAM), neden PARTNER_LATENCY.
    const cov = await protection.coverage.view(P1, at(3));
    expect(cov.level).toBe('FULL');
    expect(cov.reasons).toContain('PARTNER_LATENCY');
    expect((await health.list())[0]).toMatchObject({ partner: 'FAKE_PENDANT', degradedSince: at(2).toISOString() });
    // 1 sa sonra eski örnekler pencere dışı; hızlı 25 olay → düzeldi.
    clockNow = () => at(3700);
    await deliver(Array.from({ length: 25 }, () => ({ ...ev('HEARTBEAT', 'LAT-1'), at: at(3700 - 2).toISOString() })));
    expect((await health.sweep(at(3701)))[0]).toMatchObject({ degradedSince: null, samples: 25 });
    expect(
      await h.rows(`SELECT 1 FROM audit.log WHERE id > ${auditMark} AND action = 'partner.latency_recovered'`),
    ).toHaveLength(1);
    expect((await protection.coverage.view(P1, at(3701))).reasons).not.toContain('PARTNER_LATENCY');
    expect(v.deviceId).toBeTruthy();
  });
});
