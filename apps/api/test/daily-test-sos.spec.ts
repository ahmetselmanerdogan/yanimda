import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import { RecordingPush } from '../src/modules/device/push.port';
import type { EventService } from '../src/modules/event/event.service';
import { NotifyService } from '../src/modules/notify/notify.service';
import type { Actor } from '../src/modules/profile/contacts';
import { ProfileService } from '../src/modules/profile/profile.service';
import { localDayBounds, localParts, type SignalPoint, summarize } from '../src/modules/report/daily-summary';
import { DailySummaryService } from '../src/modules/report/daily-summary.service';
import { createHarness, type Harness } from './support/harness';

/**
 * T-062 günlük özet (C-07, B-10) ve T-063 test çağrısı (C-05). Kabul:
 *  - özet değerleri test verisiyle doğru; bildirim kapalıysa gönderilmez
 *  - test olayı gerçek metrikleri etkilemez; 112 adımı yok; bildirimler "test" koduyla
 */
const PERSON = '0190c000-0000-7000-8000-0000000000aa';
const TZ = 'Europe/Istanbul'; // UTC+3, yaz saati yok
const ALICE: Actor = { kind: 'FAMILY', id: 'fam-1' };
const at = (iso: string) => new Date(iso);
const pt = (iso: string, kind: string, extra: Partial<SignalPoint> = {}): SignalPoint => ({
  time: at(iso),
  deviceId: 'watch',
  kind,
  value: null,
  ...extra,
});

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(`
    INSERT INTO profile.protected_person (id, display_name, timezone) VALUES ('${PERSON}', 'Fatma K.', '${TZ}');
    INSERT INTO profile.family_member (id, protected_person_id, subject, role)
      VALUES ('0190c000-0000-7000-8000-0000000000f1', '${PERSON}', 'fam-1', 'OWNER');
    INSERT INTO notify.push_target (id, subject, platform, token)
      VALUES ('0190c000-0000-7000-8000-0000000000b1', 'fam-1', 'FCM', '${'t'.repeat(40)}');`);
});
afterAll(async () => {
  await h.close();
});

describe('özet hesabı (saf)', () => {
  const start = at('2026-11-08T21:00:00Z'); // 9 Kasım 00:00 İstanbul
  const end = at('2026-11-09T21:00:00Z');

  it('adım: cihaz başına en büyük kümülatif, cihazlar arasında en büyük (toplam değil)', () => {
    const s = summarize(
      [
        pt('2026-11-09T06:00:00Z', 'HEARTBEAT', { steps: 1200 }),
        pt('2026-11-09T12:00:00Z', 'STEPS', { value: 4100 }),
        pt('2026-11-09T10:00:00Z', 'HEARTBEAT', { deviceId: 'phone', steps: 3900 }),
        pt('2026-11-08T20:00:00Z', 'STEPS', { value: 9999 }), // önceki gün
      ],
      start,
      end,
    );
    expect(s.steps).toBe(4100);
  });

  it('nabız min/ort/maks; 25–250 dışı atılır', () => {
    const s = summarize(
      [
        pt('2026-11-09T06:00:00Z', 'HEART_RATE', { value: 60 }),
        pt('2026-11-09T07:00:00Z', 'HEART_RATE', { value: 90 }),
        pt('2026-11-09T08:00:00Z', 'HEARTBEAT', { hrAvg: 75 }),
        pt('2026-11-09T09:00:00Z', 'HEART_RATE', { value: 0 }),
        pt('2026-11-09T09:30:00Z', 'HEART_RATE', { value: 300 }),
      ],
      start,
      end,
    );
    expect([s.hrMin, s.hrAvg, s.hrMax]).toEqual([60, 75, 90]);
  });

  it('bilekte süre: takma/çıkarma çizelgesi; veri boşluğu en çok 30 dk sayılır', () => {
    const s = summarize(
      [
        pt('2026-11-09T05:00:00Z', 'ON_BODY'),
        pt('2026-11-09T05:20:00Z', 'HEARTBEAT', { onWrist: true }), // 20 dk
        pt('2026-11-09T07:20:00Z', 'HEARTBEAT', { onWrist: true }), // 2 saat boşluk → 30 dk
        pt('2026-11-09T07:30:00Z', 'OFF_BODY'), // 10 dk
        pt('2026-11-09T09:00:00Z', 'HEARTBEAT', { onWrist: false }),
      ],
      start,
      end,
    );
    expect(s.wristMinutes).toBe(20 + 30 + 10);
  });

  it('dinlenme tahmini: gece yarısı–öğlen arası adım artmayan en uzun aralık (≥ 3 saat); veri yoksa yok', () => {
    const s = summarize(
      [
        pt('2026-11-08T21:30:00Z', 'STEPS', { value: 10 }), // 00:30
        pt('2026-11-08T22:00:00Z', 'STEPS', { value: 40 }), // 01:00 hareket
        pt('2026-11-09T03:00:00Z', 'STEPS', { value: 40 }), // 06:00 aynı
        pt('2026-11-09T04:30:00Z', 'STEPS', { value: 300 }), // 07:30 hareket
      ],
      start,
      end,
    );
    expect([s.restStart?.toISOString(), s.restEnd?.toISOString()]).toEqual([
      '2026-11-08T22:00:00.000Z',
      '2026-11-09T04:30:00.000Z',
    ]);
    expect(summarize([], start, end)).toMatchObject({ steps: null, hrAvg: null, wristMinutes: 0, restStart: null });
  });

  it('yerel gün sınırları ve yaz saati geçişi', () => {
    expect(localDayBounds('2026-11-09', TZ)).toEqual({ start, end });
    const berlin = localDayBounds('2026-03-29', 'Europe/Berlin'); // 23 saatlik gün
    expect(berlin.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect((berlin.end.getTime() - berlin.start.getTime()) / 3600_000).toBe(23);
    expect(localParts(at('2026-11-09T17:10:00Z'), TZ)).toEqual({ day: '2026-11-09', minutes: 20 * 60 + 10 });
  });
});

describe('gece işi ve F-DAILY', () => {
  let push: RecordingPush;
  let notify: NotifyService;
  let daily: DailySummaryService;
  const fcmSent: { body?: string }[] = [];
  beforeEach(async () => {
    fcmSent.length = 0;
    push = new RecordingPush();
    const fcm = {
      send: async (m: { body?: string }) => (fcmSent.push(m), { status: 'ok' as const, id: 'x' }),
    };
    notify = new NotifyService(h.db, push, fcm, null, { NOTIFY_SWEEP_MS: '0' });
    daily = new DailySummaryService(h.db, notify, { DAILY_SWEEP_MS: '0' });
    const sig = (iso: string, kind: string, value: number | null, payload: object, key: string) =>
      `('${iso}', 'watch-1', '${PERSON}', '${kind}', ${value ?? 'NULL'}, '${JSON.stringify(payload)}', '${key}')`;
    await h.pg
      .exec(`INSERT INTO signal.signal (time, device_id, protected_person_id, kind, value, payload, idempotency_key) VALUES
      ${[
        sig('2026-11-08T06:00:00Z', 'ON_BODY', null, {}, 'a1'),
        sig(
          '2026-11-08T06:20:00Z',
          'HEARTBEAT',
          null,
          { payload: { steps: 800, hrAvg: 70 }, device: { onWrist: true } },
          'a2',
        ),
        sig('2026-11-08T12:00:00Z', 'HEART_RATE', 88, {}, 'a3'),
        sig('2026-11-08T15:00:00Z', 'STEPS', 5200, {}, 'a4'),
        // bugün (9 Kasım)
        sig('2026-11-09T06:00:00Z', 'ON_BODY', null, {}, 'b1'),
        sig(
          '2026-11-09T08:00:00Z',
          'HEARTBEAT',
          null,
          { payload: { steps: 2400, hrAvg: 72 }, device: { onWrist: true } },
          'b2',
        ),
        sig('2026-11-09T08:30:00Z', 'HEARTBEAT', null, { payload: { steps: 3100 }, device: { onWrist: true } }, 'b3'),
      ].join(',')}`);
  });

  it('00:30 sonrası dünün özeti bir kez yazılır; değerler doğru', async () => {
    const t = at('2026-11-08T21:10:00Z'); // 9 Kasım 00:10 — henüz değil
    expect((await daily.sweep(t)).summaries).toBe(0);
    const t2 = at('2026-11-08T21:40:00Z'); // 00:40
    expect((await daily.sweep(t2)).summaries).toBe(1);
    expect((await daily.sweep(t2)).summaries).toBe(0);
    const [row] = await h.rows(
      'SELECT day::text, steps, hr_min, hr_avg, hr_max, wrist_minutes FROM signal.daily_summary',
    );
    expect(row).toEqual({ day: '2026-11-08', steps: 5200, hr_min: 70, hr_avg: 79, hr_max: 88, wrist_minutes: 50 });
  });

  it('20:00–22:00 F-DAILY günde bir kez, sayılarla; metin katalogdan', async () => {
    const t = at('2026-11-09T17:05:00Z'); // 20:05
    expect((await daily.sweep(t)).notices).toBe(1);
    expect((await daily.sweep(at('2026-11-09T17:30:00Z'))).notices).toBe(0);
    await notify.settled();
    await notify.drain(at('2026-11-09T17:31:00Z')); // plan simüle saatte: o anda vadesi gelir
    expect(fcmSent.map((m) => m.body)).toEqual(['Bugün iyi: 3.100 adım, saat 1,5 saat takılı.']);
  });

  it('bildirim kapalıysa, gece penceresinde veya kötü günde gönderilmez', async () => {
    await h.pg.exec(`UPDATE profile.protected_person SET daily_summary_enabled = false`);
    expect((await daily.sweep(at('2026-11-09T17:05:00Z'))).notices).toBe(0);
    await h.pg.exec(`UPDATE profile.protected_person SET daily_summary_enabled = true`);
    expect((await daily.sweep(at('2026-11-09T20:00:00Z'))).notices).toBe(0); // 23:00
    await h.pg
      .exec(`INSERT INTO event.event (id, protected_person_id, type, priority, state, confirmed_outcome, created_at)
      VALUES ('0190c000-0000-7000-8000-0000000000e1', '${PERSON}', 'FALL', 1, 'CLOSED', 'EMERGENCY', '2026-11-09T10:00:00Z')`);
    expect((await daily.sweep(at('2026-11-09T17:05:00Z'))).notices).toBe(0);
  });

  it('aile ekranı: bugün kısmi + kayıtlı günler; aile anahtarıyla kapatılır', async () => {
    await daily.sweep(at('2026-11-08T21:40:00Z'));
    const list = await daily.recent(PERSON, 7, at('2026-11-09T17:05:00Z'));
    expect(list.map((x) => [x.day, x.steps, x.partial])).toEqual([
      ['2026-11-09', 3100, true],
      ['2026-11-08', 5200, false],
    ]);
    const profile = new ProfileService(h.db, new FieldCipher(`k:${Buffer.alloc(32, 1).toString('base64')}`));
    expect((await profile.update(ALICE, PERSON, { dailySummary: false })).dailySummary).toBe(false);
  });
});

describe('test çağrısı (T-063)', () => {
  let events: EventService;
  let chain: ChainService;
  let profile: ProfileService;
  let notify: NotifyService;
  const fcmSent: { body?: string }[] = [];
  beforeEach(() => {
    fcmSent.length = 0;
    events = h.events(new InMemoryTimers());
    chain = new ChainService(h.db, events, loadProcedures());
    profile = new ProfileService(
      h.db,
      new FieldCipher(`k:${Buffer.alloc(32, 1).toString('base64')}`),
      undefined,
      undefined,
      events,
    );
    const fcm = { send: async (m: { body?: string }) => (fcmSent.push(m), { status: 'ok' as const, id: 'x' }) };
    notify = new NotifyService(h.db, new RecordingPush(), fcm, null, { NOTIFY_SWEEP_MS: '0' });
    notify.subscribe();
  });
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return (e as { status?: number }).status;
    }
  };

  it('TEST olayı: P4, isTest, 112 yok, kurulum metni; aynı anahtar aynı olay; 10 dk içinde ikinci 429', async () => {
    const r = await profile.testSos(ALICE, PERSON, 'istek-anahtari-1');
    expect(r).toMatchObject({ completed: false, operatorNote: null });
    expect(await profile.testSos(ALICE, PERSON, 'istek-anahtari-1')).toMatchObject({ eventId: r.eventId });
    const [ev] = await h.rows<{ type: string; priority: number; is_test: boolean; state: string }>(
      'SELECT type, priority, is_test, state FROM event.event WHERE id = $1',
      [r.eventId],
    );
    expect(ev).toEqual({ type: 'TEST', priority: 4, is_test: true, state: 'OPERATOR_QUEUE' });
    const c = await chain.claim(r.eventId, 'op-1');
    expect(c.chain!.steps.map((s) => [s.kind, s.script])).toEqual([
      ['CALL_WATCH', 'O-SCRIPT-TEST'],
      ['CALL_PHONE', 'O-SCRIPT-TEST'],
    ]);
    expect(await status(profile.testSos(ALICE, PERSON, 'istek-anahtari-2'))).toBe(409); // açık olay
    await chain.close(r.eventId, 'op-1', { outcome: 'TEST', note: 'Saat ve telefon çalışıyor, düğme denendi.' });
    const done = await profile.testStatus(ALICE, PERSON, r.eventId);
    expect(done).toMatchObject({
      completed: true,
      outcome: 'TEST',
      operatorNote: 'Saat ve telefon çalışıyor, düğme denendi.',
    });
    expect(await status(profile.testSos(ALICE, PERSON, 'istek-anahtari-3'))).toBe(429);
  });

  it('başka aile 404; aileye yalnız "test" bildirimleri (acil SMS/sesli yok)', async () => {
    const bob: Actor = { kind: 'FAMILY', id: 'fam-2' };
    expect(await status(profile.testSos(bob, PERSON, 'istek-anahtari-9'))).toBe(404);
    const r = await profile.testSos(ALICE, PERSON, undefined);
    expect(await status(profile.testStatus(bob, PERSON, r.eventId))).toBe(404);
    await chain.claim(r.eventId, 'op-1');
    await chain.close(r.eventId, 'op-1', { outcome: 'TEST' });
    await h.worker().drain();
    await notify.settled();
    const codes = await h.rows<{ code: string; channel: string }>(
      'SELECT code, channel FROM notify.notification ORDER BY created_at',
    );
    expect(codes).toEqual([
      { code: 'F-TEST-QUEUED', channel: 'PUSH' },
      { code: 'F-TEST-DONE', channel: 'PUSH' },
    ]);
    expect(fcmSent.map((m) => m.body)).toEqual([
      'Test: Fatma K. için test çağrısı operatörümüze ulaştı.',
      'Test tamamlandı. Fatma K. için koruma çalışıyor.',
    ]);
  });
});
