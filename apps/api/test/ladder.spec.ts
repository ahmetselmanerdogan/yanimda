import type { ChainStep, DeviceSummary, KafkaEnvelope, Signal } from '@yanimda/contracts';
import { t } from '@yanimda/messages';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import {
  autoSkip,
  bestVoiceTarget,
  distanceM,
  type LadderContext,
  orderForCorroboration,
  ringTargets,
  voiceTargetOf,
} from '../src/modules/chain/ladder';
import { LadderService } from '../src/modules/chain/ladder.service';
import { buildSteps, loadProcedures } from '../src/modules/chain/procedures';
import { defaultRegistry, DeviceService } from '../src/modules/device/device.service';
import { RecordingPush } from '../src/modules/device/push.port';
import type { EventService } from '../src/modules/event/event.service';
import {
  call112DeadlineSecOf,
  fusionOf,
  ladderOf,
  loadRulePack,
  ruleFor,
  type RulePack,
  staticRules,
} from '../src/modules/event/rules.loader';
import { deliveryFor } from '../src/modules/notify/policy';
import { parseContacts, pickKeyHolder, reachableAt } from '../src/modules/profile/contacts';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-087 ulaşılamama merdiveni (docs/07 S5). Kabul (S10.1 "2. Merdiven"):
 *  - her süre (S5.2, S5.4) tablo testinde
 *  - aramadan önce son görülme ≤ 15 dk; ölü cihaz "çevrimdışı — atlandı" (sistem, kayıtlı)
 *  - otomatik cevaplı sessiz arama olası acil durum; işitme/konuşma güçlüğünde ulaşılamadı + yakınlara erken
 *  - evden uzakta komşu/anahtar sahibi atlanır; anahtar sahibi varma süresi en kısa olan
 *  - 112 son sınırı kuyruğa düşüşten (SOS 180, düşme 300, hareketsizlik 1200)
 *  - 90 sn üstlenilmeyen P1 → amir; 180 sn sesli mesaj yalnız bayrakla
 *  - sistem 112'yi aramaz, P1'i kapatmaz
 */
const pack = loadRulePack('TR');
const proc = loadProcedures('TR');
const OP = 'op-1';
const PERSON = '0190a0b0-0000-7000-8000-000000000001';
const WATCH = '0190a0b0-0000-7000-8000-00000000a001';
const PHONE = '0190a0b0-0000-7000-8000-00000000a002';
/**
 * Olayı açan cihaz: ev ünitesi (S3.5 SOS açabilir; sesli ama rehber rolü yok → merdivende aranmaz). Saat veya telefon
 * olsaydı sinyali onu kapsama olgularında "şimdi görüldü" yapardı; çevrimdışı atlama testleri saat/telefonun kayıttaki
 * son görülmesine bakar.
 */
const HOME_UNIT = '0190a0b0-0000-7000-8000-00000000a00f';
const WATCH_SRC = { kind: 'WEAROS_WATCH', role: 'WATCH' };
const HOME_SRC = {
  kind: 'SIMULATOR',
  role: 'WATCH',
  category: 'HOME_UNIT',
  tier: 'A',
  caps: { sos: true, fall: false, voice: true, location: false },
};

let h: Harness;
let events: EventService;
let chain: ChainService;
let push: RecordingPush;
let devices: DeviceService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  events = h.events(new InMemoryTimers());
  push = new RecordingPush();
  devices = new DeviceService(h.db, defaultRegistry(push));
  chain = new ChainService(h.db, events, proc, undefined, undefined, staticRules(pack));
});
afterAll(async () => {
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status ?? (e as Error).message;
  }
};
const minAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function person(o: { impaired?: boolean; home?: { lat: number; lng: number } } = {}) {
  await h.pg.query(
    `INSERT INTO profile.protected_person (id, display_name, hearing_speech_impaired, lat, lng) VALUES ($1, 'Ayşe', $2, $3, $4)`,
    [PERSON, !!o.impaired, o.home?.lat ?? null, o.home?.lng ?? null],
  );
}
/** Kayıtlı cihaz; son durum (görülme, takılı, şarj) sinyal alımında kayda yazılanlardır (T-085). */
async function device(
  id: string,
  kind: string,
  lastSeenMinAgo: number | null,
  onWrist: boolean | null = true,
  charging = false,
) {
  await h.pg.query(
    `INSERT INTO device.device (id, protected_person_id, kind, last_seen_at, on_wrist, charging)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, PERSON, kind, lastSeenMinAgo === null ? null : minAgo(lastSeenMinAgo), onWrist, charging],
  );
}
async function queued(kind = 'SOS', extra: Record<string, unknown> = {}) {
  await deliver(sig(kind, { protectedPersonId: PERSON, deviceId: HOME_UNIT, source: HOME_SRC, ...extra }));
  const [row] = await h.rows<{ id: string; state: string }>(
    'SELECT id, state FROM event.event WHERE protected_person_id = $1',
    [PERSON],
  );
  return row!.id;
}
const escalateNow = async (id: string) => {
  // Düşme/hareketsizlik sorusunu beklemeden kuyruğa (soru süresi geçmiş gibi).
  await h.pg.query(`UPDATE event.event SET device_prompt_until = now() - interval '1 hour' WHERE id = $1`, [id]);
  await events.recoverOverdue(0);
};
const label = (s: ChainStep) => (s.contactIndex ? `${s.kind}:${s.contactIndex}` : s.kind);
const outbox = (topic: string) =>
  h.rows<{ payload: { payload: Record<string, unknown> } }>(
    'SELECT envelope AS payload FROM event.outbox WHERE topic = $1 ORDER BY id',
    [topic],
  );

describe('S5.2 / S5.4 süre tablosu (kural paketi)', () => {
  // [olay, [adım, süre (sn), otomatik cevap (sn) | undefined]...]
  const TABLE: [string, [string, number, number | undefined][]][] = [
    [
      'SOS',
      [
        ['CALL_WATCH', 20, 10],
        ['CALL_PHONE', 20, 10],
        ['CALL_REDIAL', 15, 10],
        ['CALL_CONTACT:1', 25, undefined],
        ['CALL_CONTACT:2', 25, undefined],
        ['CALL_KEY_HOLDER', 25, undefined],
        ['CALL_112', 0, undefined],
      ],
    ],
    [
      'FALL',
      [
        ['CALL_WATCH', 20, 10],
        ['CALL_PHONE', 20, 10],
        ['CALL_REDIAL', 15, 10],
        ['CALL_CONTACT:1', 25, undefined],
        ['CALL_CONTACT:2', 25, undefined],
        ['CALL_KEY_HOLDER', 25, undefined],
        ['CALL_NEIGHBOR', 25, undefined],
        ['CALL_112', 0, undefined],
      ],
    ],
    [
      // P2: otomatik cevap yok (yalnız P1, S5.8)
      'INACTIVITY',
      [
        ['CALL_WATCH', 20, undefined],
        ['CALL_PHONE', 20, undefined],
        ['CALL_CONTACT:1', 25, undefined],
        ['CALL_CONTACT:2', 25, undefined],
        ['CALL_KEY_HOLDER', 25, undefined],
        ['CALL_NEIGHBOR', 25, undefined],
        ['CALL_112', 0, undefined],
      ],
    ],
  ];

  it.each(TABLE)('%s: adım sırası, süreler, otomatik cevap', async (type, expected) => {
    await person();
    const id = await queued(type);
    if (type !== 'SOS') await escalateNow(id);
    const r = await chain.claim(id, OP);
    expect(r.chain!.steps.map((s) => [label(s), s.timeoutSec, s.autoAnswerSec])).toEqual(expected);
  });

  // S5.4 kapsama boşluğu nedenleri (P3): sesli ön eleme (WATCH_OFF) → telefon → 1. yakın; 112 yok
  it.each(['WATCH_OFF', 'BATTERY_DEAD', 'CONNECTION_LOST'] as const)('%s: telefon → 1. yakın, 112 yok', (type) => {
    const steps = buildSteps(ruleFor(pack, type)!, false, proc);
    expect(steps.map((s) => [label(s), s.timeoutSec])).toEqual([
      ['CALL_PHONE', 15],
      ['CALL_CONTACT:1', 25],
    ]);
    expect(call112DeadlineSecOf(pack, type)).toBeNull();
  });

  it('kişiye yönelik denemeler ≤ 75 sn (S5.2)', () => {
    for (const type of ['SOS', 'FALL'] as const) {
      const steps = buildSteps(ruleFor(pack, type)!, false, proc).filter((s) =>
        ['WATCH', 'ELDER_PHONE', 'VOICE_DEVICE'].includes(s.target),
      );
      expect(steps.reduce((a, s) => a + s.timeoutSec, 0)).toBeLessThanOrEqual(75);
    }
  });

  it.each([
    ['SOS', 180],
    ['FALL', 300],
    ['INACTIVITY', 1200],
    ['WATCH_OFF', null],
    ['CALLBACK', null],
  ] as const)('%s: 112 son sınırı %s sn', (type, sec) => {
    expect(call112DeadlineSecOf(pack, type)).toBe(sec);
  });

  it('merdiven ve birleştirme parametreleri (S5.1, S5.3, S5.5, S3.3)', () => {
    // S5.1 çevrimdışı atlama kapsamanın çevrimiçi kuralıdır (A 15 dk, B 30 dk) — ayrı merdiven eşiği yok.
    expect(pack.coverage!.onlineMin).toEqual({ A: 15, B: 30 });
    expect(ladderOf(pack)).toEqual({
      autoAnswerSec: 10,
      unclaimedSupervisorSec: 90,
      unclaimedVoiceContact: { enabled: false, afterSec: 180, phrase: 'V-NO-OPERATOR' },
      awayFromHomeM: 200,
      operatorPrompt: { windowSec: 60, tts: 'W-INACT-1' }, // T-089 operatörün "Soru gönder" komutu
    });
    expect(fusionOf(pack)).toMatchObject({ corroborateSec: 90, corroboratedPromptSec: 30, crossCancelFollowUp: true });
    expect(ruleFor(pack, 'SOS')!.silenceIsEmergencySec).toBe(20);
    expect(ruleFor(pack, 'FALL')!.devicePrompt).toMatchObject({ windowSec: 60 });
    // S5.4 hareketsizlik: sessiz soru 120 sn → sesli ön eleme 120 sn
    const inact = ruleFor(pack, 'INACTIVITY')!;
    expect(inact.devicePrompt).toMatchObject({ windowSec: 120, silent: true });
    expect(inact.autoVoiceScreening).toMatchObject({ enabled: true, timeoutSec: 120 });
    expect(ruleFor(pack, 'SOS')!.autoVoiceScreening).toBeUndefined();
  });

  it('112 son sınırı kuyruğa düşüşten sayılır; test olayında yok', async () => {
    await person();
    const id = await queued('SOS');
    const v = await chain.get(id);
    expect(v.ladder.call112DeadlineSec).toBe(180);
    expect(Date.parse(v.ladder.call112DeadlineAt!) - Date.parse(v.event.escalatedAt!)).toBe(180_000);
    await h.pg.exec(`DELETE FROM event.transition; DELETE FROM event.event`);
    const fall = await queued('FALL');
    await escalateNow(fall);
    const f = await chain.get(fall);
    expect(Date.parse(f.ladder.call112DeadlineAt!) - Date.parse(f.event.escalatedAt!)).toBe(300_000);
    await h.pg.query(`UPDATE event.event SET is_test = true WHERE id = $1`, [fall]);
    expect((await chain.get(fall)).ladder.call112DeadlineAt).toBeNull();
  });
});

describe('S5.1 çevrimdışı cihaz atlanır', () => {
  it('saat 30 dk önce görüldü → 1. adım OFFLINE_SKIPPED (sistem), telefon sıradaki; denetim kaydı', async () => {
    await person();
    await device(WATCH, 'WEAROS_WATCH', 30);
    await device(PHONE, 'ANDROID_PHONE', 1, null);
    const id = await queued('SOS');
    const r = await chain.claim(id, OP);
    expect(r.chain!.steps[0]).toMatchObject({
      kind: 'CALL_WATCH',
      result: 'OFFLINE_SKIPPED',
      reason: 'O-RES-SKIPPED_OFFLINE',
    });
    expect(r.chain!.steps[0]!.operatorId).toBeUndefined();
    expect(r.chain!.current).toBe(2);
    const [a] = await h.rows<{ actor_kind: string; data: { result: string } }>(
      `SELECT actor_kind, data FROM audit.log WHERE entity_id = $1 AND action = 'chain.step.auto_skipped'`,
      [id],
    );
    expect(a).toMatchObject({ actor_kind: 'SYSTEM', data: { result: 'OFFLINE_SKIPPED' } });
    expect(t('O-RES-SKIPPED_OFFLINE')).toBeTruthy();
    // Telefon cevapsız → yeniden arama telefona (tek çevrimiçi sesli cihaz) atlanmaz
    const after = await chain.stepResult(id, 2, OP, { result: 'NO_ANSWER' });
    expect(after.chain!.current).toBe(3);
    expect(after.chain!.steps[2]).toMatchObject({ kind: 'CALL_REDIAL', target: 'VOICE_DEVICE' });
  });

  it('tüm sesli cihazlar çevrimdışı → cihaz adımları atlanır, ilk yakın sıradaki (≈55 sn kazanılır)', async () => {
    await person();
    await device(WATCH, 'WEAROS_WATCH', 16);
    await device(PHONE, 'IOS_PHONE', 90, null);
    const r = await chain.claim(await queued('SOS'), OP);
    expect(r.chain!.steps.slice(0, 3).map((s) => s.result)).toEqual([
      'OFFLINE_SKIPPED',
      'OFFLINE_SKIPPED',
      'OFFLINE_SKIPPED',
    ]);
    expect(r.chain!.current).toBe(4);
  });

  it('cihaz kaydı yoksa (yalnız rehber numarası) atlanmaz; 15 dk içindeki cihaz atlanmaz', async () => {
    await person();
    const r = await chain.claim(await queued('SOS'), OP);
    expect(r.chain!.current).toBe(1);
    await h.reset();
    events = h.events(new InMemoryTimers());
    chain = new ChainService(h.db, events, proc, undefined, undefined, staticRules(pack));
    await person();
    await device(WATCH, 'WEAROS_WATCH', 14);
    expect((await chain.claim(await queued('SOS'), OP)).chain!.current).toBe(1);
  });

  it('cihaz durumu kapsama olgularından: kayıtta 30 dk önce görülen saatten yeni sinyal geldiyse atlanmaz', async () => {
    await person();
    await device(WATCH, 'WEAROS_WATCH', 30);
    await deliver(sig('HEARTBEAT', { protectedPersonId: PERSON, deviceId: WATCH, source: WATCH_SRC }));
    expect((await chain.claim(await queued('SOS'), OP)).chain!.current).toBe(1);
  });

  it('operatör OFFLINE_SKIPPED giremez (400)', async () => {
    await person();
    const id = await queued('SOS');
    await chain.claim(id, OP);
    expect(await status(chain.stepResult(id, 1, OP, { result: 'OFFLINE_SKIPPED' }))).toBe(400);
  });
});

describe('S5.1 sessiz otomatik cevap / S5.9 işitme-konuşma güçlüğü', () => {
  it('sessiz (SILENT) cihaz araması olası acil durum: konsol uyarısı, zincir sürer', async () => {
    await person();
    const id = await queued('SOS');
    await chain.claim(id, OP);
    const r = await chain.stepResult(id, 1, OP, { result: 'SILENT' });
    expect(r.chain!.steps[0]!.result).toBe('SILENT');
    expect(r.chain!.current).toBe(2);
    expect(r.ladder.possibleEmergency).toBe(true);
    expect(r.event.state).toBe('CONTACT_CHAIN');
    const ups = (await outbox('event.updated')).map((o) => o.payload.payload);
    expect(ups).toContainEqual(expect.objectContaining({ eventId: id, reason: 'POSSIBLE_EMERGENCY', n: 1 }));
  });

  it('SILENT yalnız cihaz aramasında (yakın adımında 400)', async () => {
    await person();
    await device(WATCH, 'WEAROS_WATCH', 60);
    await device(PHONE, 'ANDROID_PHONE', 60, null);
    const id = await queued('SOS');
    const r = await chain.claim(id, OP);
    expect(r.chain!.current).toBe(4); // cihazlar çevrimdışı
    expect(await status(chain.stepResult(id, 4, OP, { result: 'SILENT' }))).toBe(400);
  });

  it('işitme/konuşma güçlüğü: ilk cihaz denemesinden sonra telefon ve yeniden arama atlanır; sessizlik acil sayılmaz', async () => {
    await person({ impaired: true });
    const id = await queued('SOS');
    await chain.claim(id, OP);
    const r = await chain.stepResult(id, 1, OP, { result: 'SILENT' });
    expect(r.chain!.steps.slice(1, 3).map((s) => [s.result, s.reason])).toEqual([
      ['SKIPPED', 'O-SKIP-IMPAIRED'],
      ['SKIPPED', 'O-SKIP-IMPAIRED'],
    ]);
    expect(r.chain!.current).toBe(4);
    expect(r.ladder).toMatchObject({ possibleEmergency: false, hearingSpeechImpaired: true });
  });

  it('işitme/konuşma güçlüğü: ilk cihaz çevrimdışı atlandıysa bir cihaz yine denenir', async () => {
    await person({ impaired: true });
    await device(WATCH, 'WEAROS_WATCH', 60);
    await device(PHONE, 'ANDROID_PHONE', 1, null);
    const r = await chain.claim(await queued('SOS'), OP);
    expect(r.chain!.current).toBe(2);
  });
});

describe('S5.5 evden uzak / S5.6 anahtar sahibi', () => {
  const HOME = { lat: 41.0, lng: 29.0 };
  const walkTo = async (id: string, kind: string) => {
    for (;;) {
      const v = await chain.get(id);
      const cur = v.chain!.steps.find((s) => s.n === v.chain!.current)!;
      if (cur.kind === kind || cur.kind === 'CALL_112') return v;
      await chain.stepResult(id, cur.n, OP, { result: 'NO_ANSWER' });
    }
  };

  it('kişi evden 1 km uzakta: anahtar sahibi ve komşu atlanır (O-SKIP-AWAY), sıradaki 112', async () => {
    await person({ home: HOME });
    await h.pg.query(
      `INSERT INTO profile.contact (id, protected_person_id, role, priority, phone_e164, has_key, arrival_min)
       VALUES (gen_random_uuid(), $1, 'CONTACT', 1, '+905550000001', true, 10)`,
      [PERSON],
    );
    const id = await queued('FALL', { location: { lat: 41.009, lng: 29.0, source: 'GPS' } });
    expect(distanceM(HOME, { lat: 41.009, lng: 29.0 })).toBeGreaterThan(200);
    await escalateNow(id);
    await chain.claim(id, OP);
    const v = await walkTo(id, 'CALL_KEY_HOLDER');
    const byKind = Object.fromEntries(v.chain!.steps.map((s) => [s.kind, s]));
    expect(byKind.CALL_KEY_HOLDER).toMatchObject({ result: 'SKIPPED', reason: 'O-SKIP-AWAY' });
    expect(byKind.CALL_NEIGHBOR).toMatchObject({ result: 'SKIPPED', reason: 'O-SKIP-AWAY' });
    expect(v.chain!.steps.find((s) => s.n === v.chain!.current)!.kind).toBe('CALL_112');
  });

  it('evde (50 m) ve anahtar sahibi var: anahtar sahibi adımı operatöre gelir; yoksa O-SKIP-NO-KEY-HOLDER', async () => {
    await person({ home: HOME });
    await h.pg.query(
      `INSERT INTO profile.contact (id, protected_person_id, role, priority, phone_e164, has_key, arrival_min)
       VALUES (gen_random_uuid(), $1, 'NEIGHBOR', 1, '+905550000009', true, 5)`,
      [PERSON],
    );
    const id = await queued('SOS', { location: { lat: 41.0004, lng: 29.0, source: 'GPS' } });
    await chain.claim(id, OP);
    const v = await walkTo(id, 'CALL_KEY_HOLDER');
    expect(v.chain!.steps.find((s) => s.n === v.chain!.current)).toMatchObject({
      kind: 'CALL_KEY_HOLDER',
      target: 'KEY_HOLDER',
      script: 'O-SCRIPT-KEY-HOLDER',
    });
    const r = await chain.stepResult(id, v.chain!.current!, OP, { result: 'SKIPPED', reason: 'test' });
    expect(r.chain!.steps.find((s) => s.kind === 'CALL_112')!.n).toBe(r.chain!.current);
  });

  it('anahtar sahibi yoksa adım sistemce atlanır', async () => {
    await person();
    const id = await queued('SOS');
    await chain.claim(id, OP);
    const v = await walkTo(id, 'CALL_KEY_HOLDER');
    expect(v.chain!.steps.find((s) => s.kind === 'CALL_KEY_HOLDER')).toMatchObject({
      result: 'SKIPPED',
      reason: 'O-SKIP-NO-KEY-HOLDER',
    });
  });

  it('anahtar sahibi seçimi: ulaşılabilir olanlar içinde varma süresi en kısa; saat penceresi gece yarısını geçebilir', () => {
    const noon = new Date('2026-11-11T09:00:00Z'); // İstanbul 12:00
    const night = new Date('2026-11-11T21:30:00Z'); // İstanbul 00:30
    const rows = [
      { id: 'a', hasKey: true, arrivalMin: 30, reachableHours: null },
      { id: 'b', hasKey: true, arrivalMin: 5, reachableHours: '08:00-18:00' },
      { id: 'c', hasKey: false, arrivalMin: 1, reachableHours: null },
      { id: 'd', hasKey: true, arrivalMin: 10, reachableHours: '22:00-06:00' },
    ];
    expect(pickKeyHolder(rows, noon, 'Europe/Istanbul')!.id).toBe('b');
    expect(pickKeyHolder(rows, night, 'Europe/Istanbul')!.id).toBe('d');
    expect(pickKeyHolder([rows[2]!], noon, 'Europe/Istanbul')).toBeNull();
    expect(reachableAt('22:00-06:00', night, 'Europe/Istanbul')).toBe(true);
    expect(reachableAt('08:00-18:00', night, 'Europe/Istanbul')).toBe(false);
  });

  it('rehber: anahtar sahibi alanları doğrulanır', () => {
    const [c] = parseContacts([
      { role: 'CONTACT', phone: '+905550000001', hasKey: true, arrivalMin: 15, reachableHours: '08:00-22:00' },
    ]);
    expect(c).toMatchObject({ hasKey: true, arrivalMin: 15, reachableHours: '08:00-22:00' });
    const bad = (x: Record<string, unknown>) => {
      try {
        parseContacts([{ role: 'CONTACT', phone: '+905550000001', ...x }]);
        return 'ok';
      } catch (e) {
        return (e as { status?: number }).status;
      }
    };
    expect(bad({ hasKey: 'evet' })).toBe(400);
    expect(bad({ arrivalMin: 0 })).toBe(400);
    expect(bad({ reachableHours: '8-22' })).toBe(400);
    expect(
      (() => {
        try {
          parseContacts([{ role: 'ELDER', phone: '+905550000001', hasKey: true }]);
          return 'ok';
        } catch (e) {
          return (e as { status?: number }).status;
        }
      })(),
    ).toBe(400);
  });
});

describe('saf kurallar', () => {
  const ctx = (o: Partial<LadderContext> = {}): LadderContext => ({
    now: new Date(),
    devices: [],
    impaired: false,
    awayFromHome: false,
    hasKeyHolder: true,
    ...o,
  });
  const step = (target: ChainStep['target'], extra: Partial<ChainStep> = {}): ChainStep => ({
    n: 1,
    kind: 'X',
    target,
    label: 'O-STEP-WATCH',
    timeoutSec: 20,
    required: true,
    ...extra,
  });
  // Cihaz kartı (T-085 kapsama olguları); çevrimiçi kuralı kapsamanınki, burada hazır verilir.
  const dev = (id: string, category: DeviceSummary['category'], o: Partial<DeviceSummary> = {}): DeviceSummary => ({
    id,
    kind: category === 'PHONE' ? 'ANDROID_PHONE' : 'WEAROS_WATCH',
    category,
    tier: category === 'RING' ? 'C' : 'A',
    bodyLocation: null,
    nickname: null,
    online: true,
    lastSeenAt: new Date().toISOString(),
    batteryPct: 80,
    charging: false,
    chargingSince: null,
    onBody: category === 'PHONE' ? null : true,
    estimatedHoursLeft: null,
    voiceOrder: category === 'RING' ? null : category === 'PHONE' ? 3 : 1,
    voiceOrderManual: false,
    ...o,
  });

  it('aranmaya başlanmış adım atlanmaz; 112 ve yakın adımları cihaz durumuna bakmaz', () => {
    const offline = ctx({ devices: [dev('w', 'WATCH', { online: false })] });
    expect(autoSkip(step('WATCH', { calledAt: new Date().toISOString() }), [], offline)).toBeNull();
    expect(autoSkip(step('EMERGENCY'), [], offline)).toBeNull();
    expect(autoSkip(step('CONTACT'), [], offline)).toBeNull();
    expect(autoSkip(step('WATCH'), [], offline)).toEqual({
      result: 'OFFLINE_SKIPPED',
      reason: 'O-RES-SKIPPED_OFFLINE',
    });
  });

  it('en iyi sesli cihaz: doğrulayan çevrimiçiyse o, değilse sesli arama sırası (S1.8); şarjdaki en sonda', () => {
    const c = ctx({ devices: [dev('w', 'WATCH'), dev('p', 'PHONE')] });
    expect(bestVoiceTarget(c)).toBe('WATCH');
    expect(bestVoiceTarget(c, 'p')).toBe('ELDER_PHONE');
    const charging = ctx({ devices: [dev('w', 'WATCH', { charging: true, onBody: false }), dev('p', 'PHONE')] });
    expect(bestVoiceTarget(charging)).toBe('ELDER_PHONE');
    expect(bestVoiceTarget(ctx({ devices: [dev('w', 'WATCH', { online: false })] }))).toBeUndefined();
  });

  it('sesli hedef kapsama olgusundan: sesli giyilebilir → saat adımı, telefon → telefon; yüzük ve ev ünitesi aranmaz', () => {
    expect(voiceTargetOf(dev('w', 'WATCH'))).toBe('WATCH');
    expect(voiceTargetOf(dev('k', 'PENDANT'))).toBe('WATCH');
    expect(voiceTargetOf(dev('p', 'PHONE'))).toBe('ELDER_PHONE');
    expect(voiceTargetOf(dev('r', 'RING'))).toBeNull();
    expect(voiceTargetOf(dev('h', 'HOME_UNIT'))).toBeNull();
    // Yüzüğün kaydı saat adımını "çevrimdışı" yapmaz; yalnız sesli cihazlar sayılır.
    expect(autoSkip(step('WATCH'), [], ctx({ devices: [dev('r', 'RING', { online: false })] }))).toBeNull();
  });

  it('T+0 çaldırma: çevrimiçi, şarjda olmayan, çıkarılmamış A sınıfı giyilebilir + çevrimiçi telefon', () => {
    const list = [
      dev('worn', 'WATCH'),
      dev('unknown', 'PENDANT', { onBody: null }),
      dev('off', 'WATCH', { onBody: false }),
      dev('charging', 'WATCH', { charging: true, onBody: false }),
      dev('offline', 'WATCH', { online: false }),
      dev('ring', 'RING'),
      dev('phone', 'PHONE'),
      dev('home', 'HOME_UNIT'),
    ];
    expect(ringTargets(list).map((d) => d.id)).toEqual(['worn', 'unknown', 'phone']);
  });

  it('doğrulayan cihaz telefonsa telefon adımı öne alınır', () => {
    const steps = buildSteps(ruleFor(pack, 'FALL')!, false, proc);
    const re = orderForCorroboration(steps, 'ELDER_PHONE');
    expect(re.slice(0, 2).map((s) => [s.n, s.kind])).toEqual([
      [1, 'CALL_PHONE'],
      [2, 'CALL_WATCH'],
    ]);
    expect(orderForCorroboration(steps, 'WATCH')).toBe(steps);
  });
});

describe('S5.2 T+0 ve S5.3 üstlenilmeyen P1 (LadderService)', () => {
  let ladder: LadderService;
  beforeEach(() => {
    ladder = new LadderService(h.db, h.outbox, staticRules(pack), devices);
  });

  it('P1 kuyruğa ilk düşünce çevrimiçi takılı saat ve telefon çaldırılır (çevrimdışı/çıkarılmış/şarjda değil); bir kez', async () => {
    await person();
    await device(WATCH, 'WEAROS_WATCH', 1, true);
    await device(PHONE, 'ANDROID_PHONE', 2, null);
    await device('0190a0b0-0000-7000-8000-00000000a003', 'WEAROS_WATCH', 1, false); // çıkarılmış
    await device('0190a0b0-0000-7000-8000-00000000a004', 'WEAROS_WATCH', 40, true); // çevrimdışı
    await device('0190a0b0-0000-7000-8000-00000000a005', 'WEAROS_WATCH', 1, false, true); // şarjda (T-086)
    const id = await queued('SOS');
    expect(await ladder.onTransition({ eventId: id, from: 'ESCALATED', to: 'OPERATOR_QUEUE' })).toBe(2);
    expect(push.sent.map((m) => m.deviceId).sort()).toEqual([WATCH, PHONE].sort());
    expect(await ladder.onTransition({ eventId: id, from: 'ESCALATED', to: 'OPERATOR_QUEUE' })).toBe(0);
    // kilit düşmesiyle kuyruğa dönüş yeni T+0 değildir
    expect(await ladder.onTransition({ eventId: id, from: 'CONTACT_CHAIN', to: 'OPERATOR_QUEUE' })).toBe(0);
  });

  it('şarja takılan saat (CHARGE_START → kapsama olgusu) T+0 çaldırılmaz; telefon çaldırılır', async () => {
    await person();
    await device(WATCH, 'WEAROS_WATCH', 1, true);
    await device(PHONE, 'ANDROID_PHONE', 1, null);
    await deliver(sig('CHARGE_START', { protectedPersonId: PERSON, deviceId: WATCH, source: WATCH_SRC }));
    const id = await queued('SOS');
    expect(await ladder.onTransition({ eventId: id, from: 'ESCALATED', to: 'OPERATOR_QUEUE' })).toBe(1);
    expect(push.sent.map((m) => m.deviceId)).toEqual([PHONE]);
  });

  it('P1 olmayan veya test olayında çaldırma yok', async () => {
    await person();
    await device(WATCH, 'WEAROS_WATCH', 1, true);
    const id = await queued('INACTIVITY');
    await escalateNow(id);
    expect(await ladder.onTransition({ eventId: id, from: 'ESCALATED', to: 'OPERATOR_QUEUE' })).toBe(0);
    expect(push.sent).toHaveLength(0);
  });

  it('90 sn üstlenilmeyen P1 → tek O-P1-UNCLAIMED; 89 sn yok; sesli mesaj bayrak kapalıyken yok', async () => {
    await person();
    const id = await queued('SOS');
    const [{ at }] = await h.rows<{ at: Date }>(
      `SELECT max(at) AS at FROM event.transition WHERE event_id = $1 AND to_state = 'OPERATOR_QUEUE'`,
      [id],
    );
    const plus = (s: number) => new Date(new Date(at).getTime() + s * 1000);
    expect(await ladder.sweep(plus(89))).toBe(0);
    expect(await ladder.sweep(plus(90))).toBe(1);
    expect(await ladder.sweep(plus(200))).toBe(0);
    const alerts = await h.rows<{ code: string; event_id: string }>(
      'SELECT code, event_id FROM event.supervisor_alert',
    );
    expect(alerts).toEqual([{ code: 'O-P1-UNCLAIMED', event_id: id }]);
    expect((await outbox('supervisor.alert')).map((o) => o.payload.payload.code)).toEqual(['O-P1-UNCLAIMED']);
    expect(await outbox('notify.requested')).toHaveLength(0);
    // S5.8: sistem P1'i kapatmaz, 112'yi aramaz
    const [ev] = await h.rows<{ state: string }>('SELECT state FROM event.event WHERE id = $1', [id]);
    expect(ev!.state).toBe('OPERATOR_QUEUE');
    expect(t('O-P1-UNCLAIMED', 'tr', { type: 'SOS' })).toContain('SOS');
  });

  it('bayrak açıkken 180 sn üstlenilmeyen P1 → 1. yakına bir kez sesli mesaj (V-NO-OPERATOR, yalnız ses)', async () => {
    const on: RulePack = {
      ...pack,
      ladder: { ...pack.ladder, unclaimedVoiceContact: { enabled: true, afterSec: 180, phrase: 'V-NO-OPERATOR' } },
    };
    ladder = new LadderService(h.db, h.outbox, staticRules(on), devices);
    await person();
    const id = await queued('SOS');
    const [{ at }] = await h.rows<{ at: Date }>(
      `SELECT max(at) AS at FROM event.transition WHERE event_id = $1 AND to_state = 'OPERATOR_QUEUE'`,
      [id],
    );
    const plus = (s: number) => new Date(new Date(at).getTime() + s * 1000);
    await ladder.sweep(plus(179));
    expect(await outbox('notify.requested')).toHaveLength(0);
    await ladder.sweep(plus(180));
    await ladder.sweep(plus(240));
    const reqs = (await outbox('notify.requested')).map((o) => o.payload.payload);
    expect(reqs).toEqual([
      expect.objectContaining({ code: 'V-NO-OPERATOR', audience: 'FAMILY', eventId: id, protectedPersonId: PERSON }),
    ]);
    expect(deliveryFor('V-NO-OPERATOR')).toMatchObject({ voiceOnly: true, urgency: 'URGENT' });
    expect(t('V-NO-OPERATOR', 'tr', { name: 'Ayşe' })).toContain("112'yi arayın");
  });
});
