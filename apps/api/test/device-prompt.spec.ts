import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { DevicePromptService } from '../src/modules/chain/device-prompt.service';
import { defaultRegistry, DeviceService } from '../src/modules/device/device.service';
import { RecordingPush } from '../src/modules/device/push.port';
import { loadRulePack, staticRules } from '../src/modules/event/rules.loader';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-090 sunucunun cihaza sorusu (docs/07 S3.3, S3.6, S7.5, S7.6): olay DEVICE_PROMPT'a girince alarmı açan cihaza ve
 * yaşlının telefonuna PROMPT push'u. `until` mutlak bitiş: doğrulanmış düşmenin 30 sn'si istemcide de geçerli.
 */
const pack = loadRulePack('TR');
const PERSON = '0190a0b0-0000-7000-8000-000000000071';
const WATCH = '0190a0b0-0000-7000-8000-00000000e001';
const PENDANT = '0190a0b0-0000-7000-8000-00000000e002';
const PHONE = '0190a0b0-0000-7000-8000-00000000e003';
const OTHER_PHONE = '0190a0b0-0000-7000-8000-00000000e004';
const WATCH_SRC = { kind: 'WEAROS_WATCH', role: 'WATCH' };
const PHONE_SRC = { kind: 'ANDROID_PHONE', role: 'PHONE' };

let h: Harness;
let push: RecordingPush;
let prompts: DevicePromptService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  h.events(new InMemoryTimers());
  push = new RecordingPush();
  prompts = new DevicePromptService(h.db, staticRules(pack), new DeviceService(h.db, defaultRegistry(push)));
  await h.pg.query(`INSERT INTO profile.protected_person (id, display_name) VALUES ($1, 'Ayşe'), ($2, 'Başka')`, [
    PERSON,
    '0190a0b0-0000-7000-8000-000000000072',
  ]);
  await h.pg.query(
    `INSERT INTO device.device (id, protected_person_id, kind, category, last_seen_at) VALUES
       ($1, $5, 'WEAROS_WATCH', NULL, now()), ($2, $5, 'WEAROS_WATCH', 'PENDANT', now()),
       ($3, $5, 'ANDROID_PHONE', NULL, now()), ($4, $6, 'ANDROID_PHONE', NULL, now())`,
    [WATCH, PENDANT, PHONE, OTHER_PHONE, PERSON, '0190a0b0-0000-7000-8000-000000000072'],
  );
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
    await h.rows<{ id: string; state: string; device_prompt_until: Date | null }>(
      'SELECT id, state, device_prompt_until FROM event.event WHERE protected_person_id = $1 ORDER BY created_at',
      [PERSON],
    )
  ).at(-1)!;
const prompted = () => push.sent.filter((m) => m.data.type === 'PROMPT');

describe('DEVICE_PROMPT → PROMPT push (alarm cihazı + yaşlının telefonu)', () => {
  it('düşme: saate ve telefona; tür, W-* kodu, kalan süre, mutlak bitiş; tekrar teslimde bir kez', async () => {
    await deliver('FALL', WATCH);
    const e = await ev();
    expect(e.state).toBe('DEVICE_PROMPT');
    expect(await prompts.onEvent(e.id)).toBe(2);
    const until = new Date(e.device_prompt_until!).toISOString();
    expect(
      prompted()
        .map((m) => m.deviceId)
        .sort(),
    ).toEqual([WATCH, PHONE].sort());
    const m = prompted()[0]!;
    expect(m).toMatchObject({ priority: 'normal' });
    expect(m.data).toEqual({
      type: 'PROMPT',
      eventId: e.id,
      kind: 'FALL',
      tts: 'W-FALL-1',
      windowSec: expect.stringMatching(/^(59|60)$/),
      until,
      silent: 'false',
    });
    expect(m.ttlSec).toBeGreaterThanOrEqual(59);
    expect(await prompts.onEvent(e.id)).toBe(0);
    expect(prompted()).toHaveLength(2);
  });

  it('doğrulanmış düşme (2 cihaz, 90 sn): yeni, kısalan bitişle (30 sn) yeniden gönderilir', async () => {
    await deliver('FALL', WATCH);
    const first = await ev();
    await prompts.onEvent(first.id);
    await deliver('FALL', PENDANT);
    const e = await ev();
    const until = new Date(e.device_prompt_until!).toISOString();
    expect(until < new Date(first.device_prompt_until!).toISOString()).toBe(true);
    expect(await prompts.onEvent(e.id)).toBe(3); // saat, kolye (artık kaynak) ve telefon
    const last = prompted().slice(-3);
    expect(last.every((x) => x.data.until === until)).toBe(true);
    expect(Number(last[0]!.data.windowSec)).toBeLessThanOrEqual(30);
  });

  it('hareketsizlik: sessiz soru (W-INACT-1, 120 sn); kaynak telefon ise yalnız telefona', async () => {
    await deliver('INACTIVITY', PHONE);
    const e = await ev();
    expect(await prompts.onEvent(e.id)).toBe(1);
    expect(prompted()[0]!.data).toMatchObject({ kind: 'INACTIVITY', tts: 'W-INACT-1', silent: 'true' });
    expect(Number(prompted()[0]!.data.windowSec)).toBeGreaterThan(110);
  });

  it('cihaz sorusu olmayan olay (SOS), soru bitti veya olay ilerledi: gönderilmez', async () => {
    await deliver('SOS', WATCH);
    expect(await prompts.onEvent((await ev()).id)).toBe(0);
    await h.pg.query(`UPDATE event.event SET state = 'CLOSED', closed_at = now() WHERE protected_person_id = $1`, [
      PERSON,
    ]);
    await deliver('FALL', WATCH);
    const e = await ev();
    await h.pg.query(`UPDATE event.event SET device_prompt_until = now() - interval '1 second' WHERE id = $1`, [e.id]);
    expect(await prompts.onEvent(e.id)).toBe(0);
    expect(prompted()).toHaveLength(0);
  });

  it('olay akışından tetiklenir: DEVICE_PROMPT geçişi ve CORROBORATED güncellemesi (yan şerit)', async () => {
    prompts.subscribe(bus);
    try {
      await deliver('FALL', WATCH);
      const e = await ev();
      await bus.deliver('event.transitioned', {
        payload: { eventId: e.id, from: 'CREATED', to: 'DEVICE_PROMPT' },
      } as unknown as KafkaEnvelope<unknown>);
      expect(prompted()).toHaveLength(2);
      await bus.deliver('event.transitioned', {
        payload: { eventId: e.id, from: 'DEVICE_PROMPT', to: 'ESCALATED' },
      } as unknown as KafkaEnvelope<unknown>);
      expect(prompted()).toHaveLength(2);
    } finally {
      prompts.onModuleDestroy();
    }
  });
});
