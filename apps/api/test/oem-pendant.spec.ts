import { catalogs, t } from '@yanimda/messages';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { defaultRegistry, DeviceService } from '../src/modules/device/device.service';
import { RecordingPush } from '../src/modules/device/push.port';
import type { EventService } from '../src/modules/event/event.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, pendantOf, staticRules } from '../src/modules/event/rules.loader';
import { partnerSignature, RecordingPartnerGateway } from '../src/modules/partner/partner.types';
import { PartnerWebhookService } from '../src/modules/partner/partner-webhook.service';
import {
  PendantMaintenanceService,
  predictedDaysLeft,
  workOrderReason,
} from '../src/modules/partner/pendant-maintenance.service';
import { VendorLinkService } from '../src/modules/partner/vendor-link.service';
import { IdempotencyStore } from '../src/modules/signal/idempotency.store';
import { SignalService } from '../src/modules/signal/signal.service';
import { createHarness, type Harness } from './support/harness';

/**
 * T-085 / T-086 12 ay pilli kolye ve ev ünitesi (docs/07 S4.9): yaşlı hiç rahatsız edilmez; %20 altı / tahmini bitime
 * 30 gün → iş emri + aile; pil değişince iş emri kapanır; 30 gündür düğme testi yoksa aylık hatırlatma; üreticinin
 * "3/5/7 gündür takılmadı" bildirimi KAPSAMA BOŞLUĞU P3 (hastanede / seyahatte modunda açılmaz); ev ünitesinin
 * elektriği ve hat kaybı kapsama nedeni.
 */
const pack = loadRulePack('TR');
const SECRET = ['fake', 'pendant', 'maint', 'test'].join('-');
const PERSON = '00000000-0000-0000-0000-0000000002a1';
const DAY = 86_400_000;

let h: Harness;
let webhook: PartnerWebhookService;
let links: VendorLinkService;
let maintenance: PendantMaintenanceService;
let protection: ProtectionService;
let events: EventService;
let seq = 0;
let auditMark = 0;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(
    'TRUNCATE device.partner_delivery, device.partner_latency, device.partner_status, device.work_order, device.pendant_maintenance',
  );
  await h.pg.exec(`
    INSERT INTO profile.protected_person (id, display_name) VALUES ('${PERSON}', 'Ayşe');
    INSERT INTO event.threshold (protected_person_id, sleep_start, sleep_end) VALUES ('${PERSON}', '00:00', '00:00');`);
  auditMark = Number((await h.rows<{ m: number }>(`SELECT coalesce(max(id), 0)::int AS m FROM audit.log`))[0]!.m);
  const devices = new DeviceService(h.db, defaultRegistry(new RecordingPush(), new RecordingPartnerGateway()));
  const signals = new SignalService(h.db, new IdempotencyStore(h.redis), h.outbox, devices);
  webhook = new PartnerWebhookService(h.db, signals, devices, (p) => (p === 'FAKE_PENDANT' ? SECRET : null));
  links = new VendorLinkService(
    h.db,
    h.outbox,
    devices,
    new FieldCipher(`t1:${Buffer.alloc(32, 2).toString('base64')}`),
  );
  maintenance = new PendantMaintenanceService(h.db, h.outbox, staticRules(pack));
  maintenance.subscribe(h.bus);
  protection = new ProtectionService(h.db, h.outbox, staticRules(pack));
  events = h.events(new InMemoryTimers(), pack);
});
afterAll(async () => {
  await h.close();
});

const deliver = async (events: Record<string, unknown>[]) => {
  const body = JSON.stringify({ events });
  const ts = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${++seq}-${Date.now()}`;
  const r = await webhook.ingest('FAKE_PENDANT', {
    rawBody: Buffer.from(body),
    headers: {
      'x-partner-timestamp': String(ts),
      'x-partner-nonce': nonce,
      'x-partner-signature': partnerSignature(SECRET, ts, nonce, body),
    },
  });
  await h.worker().drain();
  return r;
};
const ev = (type: string, device: string, at: Date | number, extra: Record<string, unknown> = {}) => ({
  id: `evt-${++seq}`,
  type,
  device,
  at: new Date(at).toISOString(),
  ...extra,
});
const link = (vendorDeviceId: string, model: string) =>
  links.create({ protectedPersonId: PERSON, partner: 'FAKE_PENDANT', model, vendorDeviceId }, 'sup-1');
const notices = async () =>
  (
    await h.rows<{ code: string; audience: string }>(
      `SELECT envelope->'payload'->>'code' AS code, envelope->'payload'->>'audience' AS audience
       FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id`,
    )
  ).map((r) => `${r.audience}:${r.code}`);
const orders = () =>
  h.rows<{ status: string; reason: string; battery_pct: number; close_reason: string | null }>(
    `SELECT status, reason, battery_pct, close_reason FROM device.work_order ORDER BY created_at`,
  );

describe('Mesaj kataloğu', () => {
  it('kolye / ortak kodları katalogda doğru kanalda (yaşlı telefonu, aile, konsol)', () => {
    const ch = (c: string) => catalogs.tr[c]?.channel;
    expect([ch('P-PENDANT-TEST'), ch('F-PENDANT-TEST'), ch('F-PENDANT-BATTERY'), ch('O-OEM-LATENCY')]).toEqual([
      'phone',
      'family',
      'family',
      'console',
    ]);
    expect(t('F-PENDANT-BATTERY', 'tr', { name: 'Ayşe', pct: 18, days: 14 })).toContain('14 gün');
  });
});

describe('Pil tahmini ve iş emri kuralı (saf)', () => {
  const p = pendantOf(pack);
  it('tahmini bitiş: katalog ömrü ve ≥7 günlük gözlenen tüketimden erken olanı', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    expect(predictedDaysLeft(50, t0, 8760)).toBeCloseTo(182.5);
    expect(predictedDaysLeft(50, t0, null)).toBeNull();
    // 30 günde 60 → 35: 0,83 %/gün → 42 gün (katalog 127,75 günden erken)
    expect(predictedDaysLeft(35, new Date(t0.getTime() + 30 * DAY), 8760, { pct: 60, at: t0 })).toBeCloseTo(42);
    // 3 günlük eğilim yetersiz: katalog
    expect(predictedDaysLeft(55, new Date(t0.getTime() + 3 * DAY), 8760, { pct: 60, at: t0 })).toBeCloseTo(200.75);
  });
  it.each([
    [19, null, 'LOW_BATTERY'],
    [20, 200, null],
    [24, 30, 'PREDICTED_END'],
    [24, 31, null],
    [5, 1, 'LOW_BATTERY'],
  ] as const)('pil %%%i, kalan %s gün → %s', (pct, days, want) => {
    expect(workOrderReason(pct, days, p)).toBe(want);
  });
});

describe('12 ay pilli radyo kolye: bakım (S4.9)', () => {
  it('yaşlı rahatsız edilmez; %20 altı → iş emri + aile; ikinci rapor yeni iş emri açmaz; pil değişince kapanır', async () => {
    const v = await link('RAD-1', 'FAKE_PENDANT_RADIO');
    const t = Date.now();
    await deliver([ev('BATTERY', 'RAD-1', t - 3000, { battery: 50 })]);
    expect(await orders()).toEqual([]);
    await deliver([ev('BATTERY', 'RAD-1', t - 2000, { battery: 19 })]);
    await deliver([ev('BATTERY', 'RAD-1', t - 1000, { battery: 9 })]);
    expect(await orders()).toEqual([{ status: 'OPEN', reason: 'LOW_BATTERY', battery_pct: 19, close_reason: null }]);
    expect(await notices()).toEqual(['FAMILY:F-PENDANT-BATTERY']); // W-BAT-* / F-BAT-10 yok
    const [wo] = await maintenance.list({ status: 'OPEN' });
    expect(wo).toMatchObject({ kind: 'PENDANT_BATTERY', deviceId: v.deviceId, protectedPersonId: PERSON });
    expect(Date.parse(wo!.dueAt) - Date.parse(wo!.createdAt)).toBe(14 * DAY);
    await deliver([ev('BATTERY', 'RAD-1', t, { battery: 100 })]);
    expect(await orders()).toEqual([
      { status: 'DONE', reason: 'LOW_BATTERY', battery_pct: 19, close_reason: 'REPLACED' },
    ]);
    const audit = await h.rows<{ action: string }>(
      `SELECT action FROM audit.log WHERE id > ${auditMark} AND entity_type = 'work_order' ORDER BY id`,
    );
    expect(audit.map((a) => a.action)).toEqual(['work_order.opened', 'work_order.closed']);
  });

  it('tahmini bitime 30 gün kala (pil %20 üstünde) iş emri; haftalık raporlardan eğilim', async () => {
    await link('RAD-2', 'FAKE_PENDANT_RADIO');
    const t0 = Date.now() - 60 * DAY;
    await deliver([ev('BATTERY', 'RAD-2', t0, { battery: 60 })]);
    await deliver([ev('BATTERY', 'RAD-2', t0 + 30 * DAY, { battery: 35 })]); // 42 gün kaldı
    expect(await orders()).toEqual([]);
    await deliver([ev('BATTERY', 'RAD-2', t0 + 45 * DAY, { battery: 24 })]); // 0,8 %/gün → 30 gün
    expect(await orders()).toEqual([{ status: 'OPEN', reason: 'PREDICTED_END', battery_pct: 24, close_reason: null }]);
    // Tampondan geç gelen eski rapor eğilimi bozmaz.
    await deliver([ev('BATTERY', 'RAD-2', t0 + 10 * DAY, { battery: 90 })]);
    expect((await orders())[0]!.status).toBe('OPEN');
  });

  it('kısa pil ömürlü hücresel kolye bakım iş emrine girmez; yaşlıya pil uyarısı gider', async () => {
    await link('CELL-1', 'FAKE_PENDANT_CELL');
    await deliver([ev('BATTERY', 'CELL-1', Date.now() - 1000, { battery: 15 })]);
    expect(await orders()).toEqual([]);
    expect(await notices()).toContain('ELDER:W-BAT-20');
  });

  it('amir iş emrini kapatır (denetimde); ikinci kez 409, bilinmeyen 404', async () => {
    await link('RAD-3', 'FAKE_PENDANT_RADIO');
    await deliver([ev('BATTERY', 'RAD-3', Date.now() - 1000, { battery: 10 })]);
    const [wo] = await maintenance.list();
    expect((await maintenance.done(wo!.id, 'sup-9')).status).toBe('DONE');
    await expect(maintenance.done(wo!.id, 'sup-9')).rejects.toMatchObject({ status: 409 });
    await expect(maintenance.done('00000000-0000-0000-0000-000000000000', 'sup-9')).rejects.toMatchObject({
      status: 404,
    });
    await expect(maintenance.done('x', 'sup-9')).rejects.toMatchObject({ status: 404 });
    expect(await maintenance.list({ status: 'OPEN' })).toEqual([]);
    const [a] = await h.rows<{ actor_id: string; data: unknown }>(
      `SELECT actor_id, data FROM audit.log WHERE id > ${auditMark} AND action = 'work_order.closed'`,
    );
    expect(a).toEqual({ actor_id: 'sup-9', data: { reason: 'DONE' } });
  });

  it('aylık test hatırlatması: 30 gündür düğme testi yok → telefon + aile, ayda bir; test yapılınca yok; hold modunda yok', async () => {
    const v = await link('RAD-T', 'FAKE_PENDANT_RADIO');
    const now = Date.now();
    await h.pg.query(`UPDATE device.device SET enrolled_at = $2 WHERE id = $1`, [v.deviceId, new Date(now - 31 * DAY)]);
    expect(await maintenance.remindTests(new Date(now))).toBe(1);
    expect(await maintenance.remindTests(new Date(now + 1000))).toBe(0); // ayda bir
    expect(await notices()).toEqual(['ELDER:P-PENDANT-TEST', 'FAMILY:F-PENDANT-TEST']);
    // 31 gün sonra yine (hâlâ test yok)
    expect(await maintenance.remindTests(new Date(now + 31 * DAY))).toBe(1);
    // Düğme testi yapıldı → sonraki ay hatırlatma yok.
    await deliver([ev('BUTTON_TEST', 'RAD-T', now - 500)]);
    expect(await maintenance.remindTests(new Date(now + 62 * DAY - 2 * DAY))).toBe(0);
    // Hastanede / seyahatte: hiç gönderilmez.
    await h.pg.query(`UPDATE profile.protected_person SET hold_until = $2, hold_mode = 'HOSPITAL' WHERE id = $1`, [
      PERSON,
      new Date(now + 400 * DAY),
    ]);
    expect(await maintenance.remindTests(new Date(now + 200 * DAY))).toBe(0);
  });
});

describe('Takılmadı bildirimi, ev ünitesi elektriği ve hat kaybı (S4.9)', () => {
  const eventsOf = () =>
    h.rows<{ type: string; priority: number; note: string | null }>(`
      SELECT e.type, e.priority, (SELECT t.note FROM event.transition t WHERE t.event_id = e.id AND t.to_state = 'CREATED') AS note
      FROM event.event e ORDER BY e.created_at`);

  it('üretici "3/5/7 gündür takılmadı" → KAPSAMA BOŞLUĞU P3 (NOT_WORN); 2 gün → yok; yaşlıya takma hatırlatması yok', async () => {
    await link('RAD-W', 'FAKE_PENDANT_RADIO');
    await deliver([ev('NOT_WORN', 'RAD-W', Date.now() - 2000, { days: 2 })]);
    expect(await eventsOf()).toEqual([]);
    await deliver([ev('NOT_WORN', 'RAD-W', Date.now() - 1000, { days: 3 })]);
    expect(await eventsOf()).toEqual([{ type: 'COVERAGE_GAP', priority: 3, note: 'NOT_WORN' }]);
    await deliver([ev('NOT_WORN', 'RAD-W', Date.now() - 500, { days: 5 })]);
    expect(await eventsOf()).toHaveLength(1); // açık olaya eklenir
    expect((await notices()).filter((c) => c.startsWith('ELDER:'))).toEqual([]);
  });

  it('hastanede / seyahatte modunda takılmadı bildirimi olay açmaz (denetimde)', async () => {
    await h.pg.query(`UPDATE profile.protected_person SET hold_until = $2, hold_mode = 'HOSPITAL' WHERE id = $1`, [
      PERSON,
      new Date(Date.now() + DAY),
    ]);
    await link('RAD-H', 'FAKE_PENDANT_RADIO');
    await deliver([ev('NOT_WORN', 'RAD-H', Date.now() - 1000, { days: 7 })]);
    expect(await eventsOf()).toEqual([]);
    const audit = await h.rows<{ data: Record<string, unknown> }>(
      `SELECT data FROM audit.log WHERE id > ${auditMark} AND action = 'event.suppressed'`,
    );
    expect(audit).toEqual([{ data: { type: 'COVERAGE_GAP', reason: 'ON_HOLD' } }]);
  });

  it('başka bir A sınıfı cihaz takılıysa takılmadı bildirimi olay açmaz', async () => {
    await link('CELL-W', 'FAKE_PENDANT_CELL');
    await link('RAD-X', 'FAKE_PENDANT_RADIO');
    await deliver([ev('WORN', 'CELL-W', Date.now() - 2000, { confidence: 0.97 })]);
    await deliver([ev('NOT_WORN', 'RAD-X', Date.now() - 1000, { days: 7 })]);
    expect(await eventsOf()).toEqual([]);
  });

  it('ev ünitesi elektriği kesildi → HOME_UNIT_POWER_LOSS; hat düştü → LINE_LOSS ve ona bağlı radyo kolye düşer; geri gelince kalkar', async () => {
    await link('HU-1', 'FAKE_HOME_UNIT');
    await link('RAD-L', 'FAKE_PENDANT_RADIO');
    const t = Date.now();
    await deliver([
      ev('HEARTBEAT', 'HU-1', t - 9000, { mains: true, lineUp: true }),
      ev('WORN', 'RAD-L', t - 8000, { confidence: 0.99 }),
    ]);
    const view = () => protection.coverage.view(PERSON);
    expect(await view()).toMatchObject({ level: 'FULL', reasons: [] });
    await deliver([ev('POWER', 'HU-1', t - 7000, { mains: false })]);
    expect(await view()).toMatchObject({ level: 'FULL', reasons: ['HOME_UNIT_POWER_LOSS'] });
    await deliver([ev('LINE', 'HU-1', t - 6000, { lineUp: false })]);
    const down = await view();
    expect(down.level).toBe('NONE');
    expect(down.reasons).toEqual(expect.arrayContaining(['LINE_LOSS', 'HOME_UNIT_POWER_LOSS', 'ALARM_DEVICE_OFFLINE']));
    expect(down.devices.find((d) => d.category === 'PENDANT')?.online).toBe(false);
    await deliver([ev('LINE', 'HU-1', t - 5000, { lineUp: true, mains: true })]);
    expect(await view()).toMatchObject({ level: 'FULL', reasons: [] });
  });

  it('hücresel kolyenin hattı düştü → çevrimdışı, LINE_LOSS; sonraki canlılıkla döner', async () => {
    await link('CELL-L', 'FAKE_PENDANT_CELL');
    const t = Date.now();
    await deliver([ev('WORN', 'CELL-L', t - 3000, { confidence: 0.9, lineUp: true })]);
    expect((await protection.coverage.view(PERSON)).level).toBe('FULL');
    await deliver([ev('LINE', 'CELL-L', t - 2000, { lineUp: false })]);
    expect(await protection.coverage.view(PERSON)).toMatchObject({ level: 'NONE' });
    expect((await protection.coverage.view(PERSON)).reasons).toContain('LINE_LOSS');
    await deliver([ev('HEARTBEAT', 'CELL-L', t - 1000, { lineUp: true })]);
    expect((await protection.coverage.view(PERSON)).level).toBe('FULL');
    expect(events).toBeTruthy();
  });
});
