import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { BRIDGED_PROFILES } from '../src/modules/device/adapters/ble-bridged.adapter';
import { BridgedDeviceService, storedAddressHash } from '../src/modules/device/bridged.service';
import { CompanionService } from '../src/modules/device/companion.service';
import type { DevicePrincipal } from '../src/modules/device/enrollment.service';
import type { EventService } from '../src/modules/event/event.service';
import { ProtectionService } from '../src/modules/event/protection.service';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-092 (docs/07 S2.1 B sınıfı, S4.8, S7.5) BLE köprülü cihaz sunucu sözleşmesi:
 *  - telefon kaydeder (`POST /devices/bridged`), ham MAC asla; (telefon, adres özeti) başına tek kayıt (idempotent)
 *  - telefon token'ı yalnız kendisine bağlı köprülü cihazların, yalnız model profilindeki sinyallerini iletebilir
 *  - BLE kolye A sınıfı SOS açar; köprü telefon susunca köprülü cihazların kapsaması düşer (S4.8)
 *  - köprü kaldırma; telefon kaldırılınca köprülü cihazlar da kaldırılır
 */
const KEY = 'k'.repeat(40); // sunucu tarafı HMAC anahtarı (test)
const PERSON = '00000000-0000-0000-0000-0000000000d1';
const OTHER = '00000000-0000-0000-0000-0000000000d2';
const PHONE = '00000000-0000-0000-0000-00000000d0f1';
const OTHER_PHONE = '00000000-0000-0000-0000-00000000d0f2';
const phone: DevicePrincipal = { deviceId: PHONE, protectedPersonId: PERSON, kind: 'ANDROID_PHONE' };
const otherPhone: DevicePrincipal = { deviceId: OTHER_PHONE, protectedPersonId: OTHER, kind: 'IOS_PHONE' };
/** İstemci: büyük harf, iki nokta ayraçlı MAC'in SHA-256'sı. */
const addr = (mac: string) => createHash('sha256').update(mac).digest('hex');
const MAC_A = 'C0:FF:EE:00:00:0A';
const MAC_B = 'C0:FF:EE:00:00:0B';

let h: Harness;
let bridged: BridgedDeviceService;
let companion: CompanionService;
let protection: ProtectionService;
let events: EventService;

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const r = (e as { getResponse?: () => { code?: string } }).getResponse?.();
    return r?.code ? `${(e as { status?: number }).status}:${r.code}` : (e as { status?: number }).status;
  }
};
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
/** Telefonun ilettiği parti: yetki (CompanionService) + alım (SignalService) + olay motoru. */
const forward = async (p: DevicePrincipal, ...batch: ReturnType<typeof sig>[]) => {
  const denied = await companion.authorizeBatch(p, batch);
  const r = await h.signals.accept(batch, denied).catch((e: unknown) => e);
  await h.worker().drain();
  return r as { accepted: number; rejected: { index: number; reason: string }[] };
};
const level = async () =>
  (
    await h.rows<{ level: string }>('SELECT level FROM event.coverage_state WHERE protected_person_id = $1', [PERSON])
  )[0]?.level;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(`
    INSERT INTO profile.protected_person (id, display_name) VALUES ('${PERSON}', 'A'), ('${OTHER}', 'B');
    INSERT INTO event.threshold (protected_person_id, sleep_start, sleep_end) VALUES ('${PERSON}', '00:00', '00:00');
    INSERT INTO device.device (id, protected_person_id, kind, model_id, category, tier, enrolled_at) VALUES
      ('${PHONE}', '${PERSON}', 'ANDROID_PHONE', 'ANDROID_PHONE', 'PHONE', 'A', now()),
      ('${OTHER_PHONE}', '${OTHER}', 'IOS_PHONE', 'IOS_PHONE', 'PHONE', 'A', now());`);
  protection = new ProtectionService(h.db, h.outbox);
  bridged = new BridgedDeviceService(h.db, h.outbox, protection, KEY);
  const rules = staticRules(loadRulePack());
  companion = new CompanionService(h.db, h.redis as never, h.outbox, {} as never, rules);
  events = h.events(new InMemoryTimers());
});
afterAll(async () => {
  await h.close();
});

describe('POST /devices/bridged (S7.5)', () => {
  it('yeni 201 + model profili; aynı telefon + adres yeniden 200 aynı kimlik; ham adres saklanmaz', async () => {
    const first = await bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A), name: 'Göğüs bandı' });
    expect(first.created).toBe(true);
    expect(first.view).toMatchObject({
      model: 'BLE_HR',
      category: 'SENSOR',
      tier: 'B',
      bridgeDeviceId: PHONE,
      nickname: 'Göğüs bandı',
      signals: BRIDGED_PROFILES.BLE_HR.signals,
    });
    const again = await bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A) });
    expect(again).toMatchObject({ created: false, view: { deviceId: first.view.deviceId } });
    const [row] = await h.rows<Record<string, unknown>>(
      'SELECT protected_person_id, kind, category, tier, connection_path, bridge_device_id, bridge_address_hash, body_location FROM device.device WHERE id = $1',
      [first.view.deviceId],
    );
    expect(row).toEqual({
      protected_person_id: PERSON,
      kind: 'BLE_HR',
      category: 'SENSOR',
      tier: 'B',
      connection_path: 'PHONE_BRIDGE',
      bridge_device_id: PHONE,
      bridge_address_hash: storedAddressHash(KEY, PHONE, addr(MAC_A)),
      body_location: 'CHEST',
    });
    expect(JSON.stringify(row)).not.toContain(addr(MAC_A));
    // Aynı adres başka telefonda başka özet (kişiler arası eşleştirme yok).
    expect(storedAddressHash(KEY, OTHER_PHONE, addr(MAC_A))).not.toBe(row!.bridge_address_hash);
    expect(await bridged.list(phone)).toEqual([expect.objectContaining({ deviceId: first.view.deviceId })]);
    const audit = await h.rows("SELECT data FROM audit.log WHERE action = 'device.bridged' AND entity_id = $1", [
      first.view.deviceId,
    ]);
    expect(audit).toEqual([{ data: { model: 'BLE_HR' } }]);
  });

  it('ham MAC 400; bozuk özet / model / alan 400; telefon olmayan token 403; adres başka modelle kayıtlı 409', async () => {
    expect(await status(bridged.register(phone, { model: 'BLE_HR', addressHash: MAC_A }))).toBe(400);
    expect(await status(bridged.register(phone, { model: 'BLE_HR', addressHash: 'c0ffee00000a' }))).toBe(400);
    expect(await status(bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A).toUpperCase() }))).toBe(
      400,
    );
    expect(await status(bridged.register(phone, { model: 'RING', addressHash: addr(MAC_A) }))).toBe(400);
    expect(await status(bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A), mac: MAC_A }))).toBe(400);
    const watch: DevicePrincipal = { deviceId: PHONE, protectedPersonId: PERSON, kind: 'WEAROS_WATCH' };
    expect(await status(bridged.register(watch, { model: 'BLE_HR', addressHash: addr(MAC_A) }))).toBe(403);
    await bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A) });
    expect(await status(bridged.register(phone, { model: 'BLE_PULSE_OX', addressHash: addr(MAC_A) }))).toBe(409);
  });

  it('kişi başına sınırlar geçerli (S1.7): 6 etkin cihazdan fazlası 409 F-DEVICE-LIMIT', async () => {
    for (let i = 0; i < 5; i++)
      expect((await bridged.register(phone, { model: 'BLE_THERMO', addressHash: addr(`MAC-${i}`) })).created).toBe(
        true,
      );
    expect(await status(bridged.register(phone, { model: 'BLE_THERMO', addressHash: addr('MAC-6') }))).toBe(
      '409:F-DEVICE-LIMIT',
    );
  });
});

describe('köprülü sinyaller (S2.1, S4.8)', () => {
  it('yalnız bu telefona bağlı köprülü cihaz ve yalnız model profilindeki sinyal türleri', async () => {
    const hr = (await bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A) })).view.deviceId;
    const ox = (await bridged.register(phone, { model: 'BLE_PULSE_OX', addressHash: addr(MAC_B) })).view.deviceId;
    const theirs = (await bridged.register(otherPhone, { model: 'BLE_HR', addressHash: addr(MAC_A) })).view.deviceId;
    const s = (deviceId: string, kind: string, extra: Record<string, unknown> = {}) =>
      sig(kind, { deviceId, protectedPersonId: PERSON, occurredAt: at(-1), ...extra });
    const r = await forward(
      phone,
      s(hr, 'HEART_RATE', { value: 72, vital: { quality: 'Q2', context: 'RESTING' }, device: { onWrist: true } }),
      s(hr, 'SPO2', { value: 97 }), // nabız ölçer oksijen gönderemez
      s(hr, 'SOS'), // B sınıfı SOS açamaz
      s(ox, 'SPO2', { value: 96, vital: { quality: 'Q2' } }),
      s(theirs, 'HEART_RATE', { value: 70 }), // başka kişinin cihazı
    );
    expect(r.accepted).toBe(2);
    expect(r.rejected.map((x) => [x.index, x.reason])).toEqual([
      [1, 'UNSUPPORTED_SIGNAL'],
      [2, 'UNSUPPORTED_SIGNAL'],
      [4, 'DEVICE_NOT_BRIDGED'],
    ]);
    const rows = await h.rows<{
      kind: string;
      payload: { device: { connectivity: string }; source: { tier: string } };
    }>('SELECT kind, payload FROM signal.signal ORDER BY kind');
    expect(rows.map((x) => [x.kind, x.payload.device.connectivity, x.payload.source.tier])).toEqual([
      ['HEART_RATE', 'BLE', 'B'],
      ['SPO2', 'BLE', 'B'],
    ]);
    expect(await events.all()).toEqual([]); // B sınıfı olay açmaz (değer kuralları bayrakla kapalı)
    // Başka kişinin telefonu bu cihazı iletemez.
    const other = await forward(otherPhone, sig('HEART_RATE', { deviceId: hr, protectedPersonId: OTHER, value: 70 }));
    expect(other).toMatchObject({ status: 403 });
  });

  it('BLE kolye SOS açar (A sınıfı); telefon susunca köprülü kolyenin kapsaması da düşer (S4.8)', async () => {
    const pendant = (await bridged.register(phone, { model: 'BLE_PENDANT', addressHash: addr(MAC_A) })).view.deviceId;
    await forward(
      phone,
      sig('HEARTBEAT', { deviceId: PHONE, protectedPersonId: PERSON, occurredAt: at(-1), device: { batteryPct: 80 } }),
      sig('ON_BODY', { deviceId: pendant, protectedPersonId: PERSON, occurredAt: at(-1), device: { batteryPct: 90 } }),
    );
    expect(await level()).toBe('BASIC'); // takılı SOS düğmesi + telefondan ses; düşme yok
    await events.sweepProtection(new Date(Date.now() + 16 * 60_000));
    expect(await level()).toBe('NONE'); // köprü telefon 15 dk sessiz → kolye de çevrimdışı
    await forward(phone, sig('SOS', { deviceId: pendant, protectedPersonId: PERSON, occurredAt: at(0) }));
    expect((await events.all()).map((e) => [e.type, e.priority])).toEqual([['SOS', 1]]);
  });
});

describe('köprü kaldırma', () => {
  it('DELETE: cihaz iptal + emekli, kapsamadan çıkar; tekrar 204; başka telefonun cihazı 404; sinyal reddedilir', async () => {
    const hr = (await bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A) })).view.deviceId;
    const theirs = (await bridged.register(otherPhone, { model: 'BLE_HR', addressHash: addr(MAC_B) })).view.deviceId;
    await forward(phone, sig('ON_BODY', { deviceId: hr, protectedPersonId: PERSON, occurredAt: at(-1) }));
    await bridged.unbridge(phone, hr);
    expect(await status(bridged.unbridge(phone, hr))).toBe('ok');
    expect(await status(bridged.unbridge(phone, theirs))).toBe(404);
    expect(await status(bridged.unbridge(phone, 'yok'))).toBe(404);
    const [row] = await h.rows<{ revoked_at: Date | null; retired_at: Date | null }>(
      'SELECT revoked_at, retired_at FROM device.device WHERE id = $1',
      [hr],
    );
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.retired_at).not.toBeNull();
    const devs = await h.rows<{ devices: Record<string, unknown> }>(
      'SELECT devices FROM event.coverage_state WHERE protected_person_id = $1',
      [PERSON],
    );
    expect(Object.keys(devs[0]!.devices)).not.toContain(hr);
    const r = await forward(phone, sig('HEART_RATE', { deviceId: hr, protectedPersonId: PERSON, value: 70 }));
    expect(r).toMatchObject({ status: 403 });
    expect(await bridged.list(phone)).toEqual([]);
    // Aynı adres yeniden kaydedilebilir (yeni kimlik).
    const again = await bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A) });
    expect(again.created).toBe(true);
    expect(again.view.deviceId).not.toBe(hr);
  });

  it('telefon kaldırılınca ona bağlı köprülü cihazlar da kaldırılır', async () => {
    await bridged.register(phone, { model: 'BLE_HR', addressHash: addr(MAC_A) });
    await bridged.register(phone, { model: 'BLE_PENDANT', addressHash: addr(MAC_B) });
    await bridged.register(otherPhone, { model: 'BLE_HR', addressHash: addr(MAC_A) });
    expect(await bridged.revokeBridgedOf(PHONE, { kind: 'FAMILY', id: 'fam-1' })).toBe(2);
    expect(await bridged.list(phone)).toEqual([]);
    expect(await bridged.list(otherPhone)).toHaveLength(1);
  });
});
