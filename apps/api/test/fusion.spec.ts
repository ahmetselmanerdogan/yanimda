import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import {
  answerAllowed,
  betterLocation,
  corroborates,
  corroborationPair,
  IM_OK_SCREEN,
  wornAlarm,
} from '../src/modules/event/fusion';
import { loadRulePack, type RulePack, staticRules } from '../src/modules/event/rules.loader';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-088 sinyal birleştirme (docs/07 S3.3–S3.7). Kabul (S10.1 "2. Merdiven"):
 *  - kolye + saat aynı düşme → tek olay, doğrulanmış, 30 sn soru; operatör "2 cihaz", ilk arama doğrulayan cihaza
 *  - olay kaynak cihaz listesini ve iptal eden cihazı tutar
 *  - iptal yalnız alarm cihazından, takılı A sınıfı cihazdan veya telefonun "İyiyim" ekranından; pencere içinde
 *  - doğrulanmış düşme başka cihazdan iptal → kapanır + aynı gün P4 takip araması (bayrak)
 *  - açık P1/P2'de konum en taze/doğru kaynaktan
 */
const pack = loadRulePack('TR');
const PERSON = '0190a0b0-0000-7000-8000-000000000002';
const W1 = '0190a0b0-0000-7000-8000-00000000b001';
const W2 = '0190a0b0-0000-7000-8000-00000000b002';
const PHONE = '0190a0b0-0000-7000-8000-00000000b003';
const WATCH_SRC = { kind: 'WEAROS_WATCH', role: 'WATCH' };
const PHONE_SRC = { kind: 'ANDROID_PHONE', role: 'PHONE' };

let h: Harness;
let timers: InMemoryTimers;
let events: EventService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  timers = new InMemoryTimers();
  events = h.events(timers);
});
afterAll(async () => {
  await h.close();
});

const deliver = (kind: string, deviceId: string, extra: Record<string, unknown> = {}) =>
  bus.deliver<Signal>('signal.received', {
    payload: sig(kind, {
      protectedPersonId: PERSON,
      deviceId,
      source: deviceId === PHONE ? PHONE_SRC : WATCH_SRC,
      ...extra,
    }),
  } as unknown as KafkaEnvelope<Signal>);
const ev = async () =>
  (
    await h.rows<{
      id: string;
      state: string;
      created_at: Date;
      device_prompt_until: Date | null;
      source_device_ids: string[];
      corroborated_at: Date | null;
      cancelled_by_device_id: string | null;
      location: Record<string, unknown> | null;
    }>('SELECT * FROM event.event WHERE protected_person_id = $1 ORDER BY created_at', [PERSON])
  ).at(-1)!;
const audits = async (id: string, action: string) =>
  h.rows<{ data: Record<string, unknown> }>(`SELECT data FROM audit.log WHERE entity_id = $1 AND action = $2`, [
    id,
    action,
  ]);
const askedAt = async (id: string) =>
  (
    await h.rows<{ at: Date }>(
      `SELECT at FROM event.transition WHERE event_id = $1 AND to_state = 'DEVICE_PROMPT' ORDER BY seq DESC LIMIT 1`,
      [id],
    )
  )[0]!.at;

describe('S3.3 doğrulama: iki farklı cihaz 90 sn içinde düşme', () => {
  it('tek olay, doğrulanmış, kaynak cihazlar; soru süresi 60 → 30 sn ve zamanlayıcı kısalır', async () => {
    await deliver('FALL', W1);
    const first = await ev();
    expect(first.state).toBe('DEVICE_PROMPT');
    expect(first.source_device_ids).toEqual([W1]);
    expect(timers.delayOf(`${first.id}.prompt-expire`)).toBe(60_000);
    await deliver('FALL', W2);
    const e = await ev();
    expect(e.id).toBe(first.id);
    expect(e.source_device_ids).toEqual([W1, W2]);
    expect(e.corroborated_at).not.toBeNull();
    expect(new Date(e.device_prompt_until!).getTime() - new Date(await askedAt(e.id)).getTime()).toBe(30_000);
    const d = timers.delayOf(`${e.id}.prompt-expire`)!;
    expect(d).toBeGreaterThan(20_000);
    expect(d).toBeLessThanOrEqual(30_000);
    expect(await audits(e.id, 'event.corroborated')).toEqual([{ data: { devices: 2, by: W2, role: 'WATCH' } }]);
    const [n] = await h.rows<{ n: number }>('SELECT count(*)::int n FROM event.event WHERE protected_person_id = $1', [
      PERSON,
    ]);
    expect(n!.n).toBe(1);
  });

  it('aynı cihazın ikinci düşmesi doğrulamaz; 90 sn sonrası doğrulamaz ama kaynak olarak eklenir', async () => {
    await deliver('FALL', W1);
    await deliver('FALL', W1);
    expect((await ev()).corroborated_at).toBeNull();
    const e = await ev();
    const late = new Date(new Date(e.created_at).getTime() + 91_000).toISOString();
    await deliver('FALL', W2, { receivedAt: late });
    const after = await ev();
    expect(after.corroborated_at).toBeNull();
    expect(after.source_device_ids).toEqual([W1, W2]);
  });

  it('doğrulama soru açılışından 30 sn sonra gelirse olay hemen kuyruğa düşer', async () => {
    await deliver('FALL', W1);
    const e = await ev();
    await h.pg.query(`UPDATE event.event SET created_at = now() - interval '45 seconds' WHERE id = $1;`, [e.id]);
    await h.pg.query(`UPDATE event.transition SET at = now() - interval '45 seconds' WHERE event_id = $1`, [e.id]);
    await deliver('FALL', W2);
    const after = await ev();
    expect(after.corroborated_at).not.toBeNull();
    expect(after.state).toBe('OPERATOR_QUEUE');
  });

  it('konsol "2 cihaz" görür; doğrulayan telefonsa ilk sesli arama telefona', async () => {
    await h.pg.query(`INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Ali')`, [PERSON]);
    await h.pg.query(
      `INSERT INTO device.device (id, protected_person_id, kind, last_seen_at, on_wrist) VALUES
        ($1, $3, 'WEAROS_WATCH', now(), true), ($2, $3, 'ANDROID_PHONE', now(), null)`,
      [W1, PHONE, PERSON],
    );
    await deliver('FALL', W1);
    await deliver('FALL', PHONE);
    const e = await ev();
    await h.pg.query(`UPDATE event.event SET device_prompt_until = now() - interval '1 hour' WHERE id = $1`, [e.id]);
    await events.recoverOverdue(0);
    const chain = new ChainService(h.db, events, loadProcedures('TR'), undefined, undefined, staticRules(pack));
    const r = await chain.claim(e.id, 'op-1');
    expect(r.ladder).toMatchObject({ corroborated: true, sourceDeviceCount: 2 });
    expect(r.chain!.steps.slice(0, 2).map((s) => s.kind)).toEqual(['CALL_PHONE', 'CALL_WATCH']);
  });

  it('şarjdaki cihazın düşmesi doğrulamaz (S3.4): şarj bilgili sinyal yok sayılır, son bilinen şarj sayılmaz', async () => {
    // Sinyal "şarjda" taşıyor: T-086 yok sayar, olaya kaynak bile olmaz.
    await deliver('FALL', W1);
    await deliver('FALL', W2, { device: { charging: true } });
    expect(await ev()).toMatchObject({ source_device_ids: [W1], corroborated_at: null });

    // Sinyal şarj bilgisi taşımıyor ama W2 son bilinen durumda şarjda: kaynak olur, doğrulamaz.
    await h.reset();
    events = h.events(timers);
    await deliver('CHARGE_START', W2);
    await deliver('FALL', W1);
    await deliver('FALL', W2);
    const e = await ev();
    expect(e).toMatchObject({ source_device_ids: [W1, W2], corroborated_at: null });
    expect(await audits(e.id, 'event.corroborated')).toEqual([]);

    // Olayı açan cihaz şarjdaydı: ikinci cihaz tek başına doğrulamaz.
    await h.reset();
    events = h.events(timers);
    await deliver('CHARGE_START', W1);
    await deliver('FALL', W1);
    await deliver('FALL', W2);
    expect((await ev()).corroborated_at).toBeNull();
  });

  it('saf: şarjdaki cihaz doğrulama çifti sayılmaz', () => {
    expect(corroborationPair([W1, W2], W2, new Set())).toBe(true);
    expect(corroborationPair([W1, W2], W2, new Set([W2]))).toBe(false);
    expect(corroborationPair([W1, W2], W2, new Set([W1]))).toBe(false);
    expect(corroborationPair([W1, W2, PHONE], PHONE, new Set([W1]))).toBe(true);
    expect(wornAlarm({ category: 'WATCH', tier: 'A', onBody: true, charging: false })).toBe(true);
  });

  it('saf: pencere sınırı', () => {
    const t0 = '2026-11-11T10:00:00.000Z';
    expect(corroborates(t0, '2026-11-11T10:01:30.000Z', 90)).toBe(true);
    expect(corroborates(t0, '2026-11-11T10:01:30.001Z', 90)).toBe(false);
  });
});

describe('S3.6 "İyiyim" kimden ve ne zaman kabul edilir', () => {
  const ignored = async (id: string) => (await audits(id, 'event.answer_ignored')).map((a) => a.data.reason as string);

  it('telefon: yalnız "İyiyim" ekranından; iptal eden cihaz kaydedilir', async () => {
    await deliver('FALL', W1);
    const e = await ev();
    await deliver('CANCEL', PHONE);
    expect((await ev()).state).toBe('DEVICE_PROMPT');
    expect(await ignored(e.id)).toEqual(['DEVICE_NOT_ALLOWED']);
    await deliver('CANCEL', PHONE, { payload: { screen: IM_OK_SCREEN } });
    const after = await ev();
    expect(after.state).toBe('CLOSED');
    expect(after.cancelled_by_device_id).toBe(PHONE);
  });

  it('başka saat: takılı değilse reddedilir, takılıysa (kapsama olgusu, son bilinen durum) kabul', async () => {
    await deliver('ON_BODY', W2); // W2 takılı (son bilinen durum)
    await deliver('FALL', W1);
    const e = await ev();
    await deliver('CANCEL', W2, { device: { onWrist: false } }); // sinyalin kendi bilgisi: çıkarılmış
    expect((await ev()).state).toBe('DEVICE_PROMPT');
    await deliver('ON_BODY', W2);
    await deliver('OK', W2); // takılı bilgisi yok → son bilinen: takılı
    expect((await ev()).state).toBe('CLOSED');
    expect(await ignored(e.id)).toEqual(['DEVICE_NOT_ALLOWED']);
  });

  it('şarjdaki saat (T-086 kapsama olgusu) başka cihazın alarmını iptal edemez', async () => {
    await deliver('ON_BODY', W2);
    await deliver('CHARGE_START', W2);
    await deliver('FALL', W1);
    const e = await ev();
    await deliver('CANCEL', W2);
    expect((await ev()).state).toBe('DEVICE_PROMPT');
    expect(await ignored(e.id)).toEqual(['DEVICE_NOT_ALLOWED']);
  });

  it('alarmı açan cihaz kabul; soru penceresi dolduktan sonra gelen iptal reddedilir', async () => {
    await deliver('FALL', W1);
    const e = await ev();
    const late = new Date(new Date(e.device_prompt_until!).getTime() + 1000).toISOString();
    await deliver('CANCEL', W1, { receivedAt: late });
    expect((await ev()).state).toBe('DEVICE_PROMPT');
    expect(await ignored(e.id)).toEqual(['AFTER_PROMPT']);
    await deliver('CANCEL', W1);
    expect((await ev()).state).toBe('CLOSED');
  });

  it('saf kurallar: B/C sınıfı, şarjdaki ve takılı bilgisi bilinmeyen cihaz reddedilir; kaynak listesi yoksa kabul', () => {
    const src = [W1];
    const fact = (o: Partial<Parameters<typeof wornAlarm>[0]> = {}) => ({
      category: 'WATCH' as const,
      tier: 'A' as const,
      onBody: true as boolean | null,
      charging: false,
      ...o,
    });
    expect(answerAllowed(src, { deviceId: W1 })).toBe(true);
    expect(answerAllowed(src, { deviceId: W2 })).toBe(false);
    expect(answerAllowed(src, { deviceId: W2, device: fact() })).toBe(true);
    expect(answerAllowed(src, { deviceId: W2, device: fact({ category: 'PENDANT' }) })).toBe(true);
    expect(answerAllowed(src, { deviceId: W2, device: fact({ onBody: false }) })).toBe(false);
    expect(answerAllowed(src, { deviceId: W2, device: fact({ onBody: null }) })).toBe(false);
    expect(answerAllowed(src, { deviceId: W2, device: fact({ charging: true }) })).toBe(false);
    expect(answerAllowed(src, { deviceId: W2, device: fact({ category: 'EARBUD', tier: 'B' }) })).toBe(false);
    expect(answerAllowed(src, { deviceId: W2, device: fact({ category: 'RING', tier: 'C' }) })).toBe(false);
    const phone = fact({ category: 'PHONE', onBody: null });
    expect(answerAllowed(src, { deviceId: PHONE, device: phone })).toBe(false);
    expect(answerAllowed(src, { deviceId: PHONE, device: phone, screen: 'IM_OK' })).toBe(true);
    expect(answerAllowed(src, { deviceId: PHONE, role: 'PHONE', screen: 'IM_OK' })).toBe(true);
    expect(answerAllowed([], { deviceId: W2 })).toBe(true);
  });
});

describe('S3.6 doğrulanmış düşme başka cihazdan iptal → takip araması', () => {
  it('kapanır, iptal eden cihaz kaydedilir, 60 dk sonra FOLLOW_UP planlanır', async () => {
    await deliver('FALL', W1);
    await deliver('FALL', W2);
    const e = await ev();
    await deliver('CANCEL', W1);
    const after = await ev();
    expect(after.state).toBe('CLOSED');
    expect(after.cancelled_by_device_id).toBe(W1);
    expect(timers.delayOf(`${e.id}.follow-up`)).toBe(60 * 60_000);
    expect(await audits(e.id, 'event.follow_up_planned')).toEqual([
      { data: { minutes: 60, reason: 'CROSS_DEVICE_CANCEL', by: W1 } },
    ]);
    await timers.fire(e.id, 'follow-up');
    await timers.idle();
    const fu = await ev();
    expect(fu).toMatchObject({ state: 'OPERATOR_QUEUE' });
    const [row] = await h.rows<{ type: string; priority: number }>(
      'SELECT type, priority FROM event.event WHERE id = $1',
      [fu.id],
    );
    expect(row).toEqual({ type: 'FOLLOW_UP', priority: 4 });
  });

  it('doğrulanmamış düşmenin iptali veya bayrak kapalıyken takip yok', async () => {
    await deliver('FALL', W1);
    const e = await ev();
    await deliver('CANCEL', W1);
    expect(timers.delayOf(`${e.id}.follow-up`)).toBeUndefined();

    await h.reset();
    timers = new InMemoryTimers();
    const off: RulePack = { ...pack, fusion: { ...pack.fusion, crossCancelFollowUp: false } };
    events = h.events(timers, off);
    await deliver('FALL', W1);
    await deliver('FALL', W2);
    const c = await ev();
    expect(c.corroborated_at).not.toBeNull();
    await deliver('CANCEL', W2);
    expect((await ev()).state).toBe('CLOSED');
    expect(timers.delayOf(`${c.id}.follow-up`)).toBeUndefined();
  });
});

describe('S3.7 konum birleştirme (açık P1/P2)', () => {
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

  it('ağ konumlu SOS: yeni GPS geçer; sonra gelen ağ konumu ve eski GPS geçmez', async () => {
    await deliver('SOS', PHONE, { location: { lat: 41, lng: 29, source: 'NETWORK' }, occurredAt: ago(60) });
    await deliver('LOCATION', W1, { location: { lat: 41.001, lng: 29.001, source: 'GPS' }, occurredAt: ago(5) });
    expect((await ev()).location).toMatchObject({ lat: 41.001, source: 'GPS' });
    await deliver('LOCATION', PHONE, { location: { lat: 41.5, lng: 29.5, source: 'NETWORK' }, occurredAt: ago(1) });
    await deliver('LOCATION', W1, { location: { lat: 41.2, lng: 29.2, source: 'GPS' }, occurredAt: ago(30) });
    expect((await ev()).location).toMatchObject({ lat: 41.001, source: 'GPS' });
  });

  it('P4 olayda konum birleştirilmez', async () => {
    await deliver('CALLBACK_REQUEST', PHONE, { location: { lat: 41, lng: 29, source: 'NETWORK' } });
    await deliver('LOCATION', W1, { location: { lat: 41.001, lng: 29.001, source: 'GPS' } });
    expect((await ev()).location).toMatchObject({ lat: 41, source: 'NETWORK' });
  });

  it('saf: 2 dk sonra GPS de "eski" sayılır; aynı sırada yenisi kazanır', () => {
    const now = new Date('2026-11-11T10:00:00Z');
    const gps = (at: string) => ({ lat: 1, lng: 1, source: 'GPS' as const, at });
    const net = (at: string) => ({ lat: 2, lng: 2, source: 'NETWORK' as const, at });
    expect(betterLocation(gps('2026-11-11T09:59:00Z'), net('2026-11-11T09:59:59Z'), now, 120)).toBe(false);
    expect(betterLocation(gps('2026-11-11T09:50:00Z'), { ...gps('2026-11-11T09:59:00Z'), lat: 3 }, now, 120)).toBe(
      true,
    );
    expect(betterLocation(null, net('2026-11-11T09:59:00Z'), now, 120)).toBe(true);
  });
});
