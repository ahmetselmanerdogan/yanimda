import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { CoverageAccess, type CoverageActor, DeviceManageController } from '../src/modules/device/coverage.controller';
import { defaultRegistry, DeviceService } from '../src/modules/device/device.service';
import { DevicePush } from '../src/modules/device/device-push';
import { RecordingPush } from '../src/modules/device/push.port';
import { ProtectionService } from '../src/modules/event/protection.service';
import type { FcmMessage, FcmResult } from '../src/modules/notify/fcm-client';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-089 (docs/07 S7.1, S8.3) operatörün cihaz komutları: POST /v1/devices/{id}/commands {type: RING|PROMPT|LOCATE|TEST}.
 * Yalnız operasyon; RING/PROMPT/LOCATE yalnız kişinin açık olayı varken; her komut denetimde; push mevcut
 * DeviceService (ring / promptUser / command) yolundan.
 */
const PERSON = '00000000-0000-0000-0000-0000000000d1';
const OTHER = '00000000-0000-0000-0000-0000000000d2';
const WATCH = '00000000-0000-0000-0000-00000000d0a1';
const PHONE = '00000000-0000-0000-0000-00000000d0f1';

let h: Harness;
let push: RecordingPush;
let controller: DeviceManageController;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await h.pg.exec(`
    INSERT INTO profile.protected_person (id, display_name) VALUES ('${PERSON}', 'A'), ('${OTHER}', 'B');
    INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES
      ('00000000-0000-0000-0000-00000000fd01', '${PERSON}', 'fam-alice', 'OWNER');
    INSERT INTO device.device (id, protected_person_id, kind, enrolled_at) VALUES
      ('${WATCH}', '${PERSON}', 'WEAROS_WATCH', now()),
      ('${PHONE}', '${PERSON}', 'ANDROID_PHONE', now());`);
  const protection = new ProtectionService(h.db, h.outbox);
  h.events(new InMemoryTimers());
  push = new RecordingPush();
  controller = new DeviceManageController(
    h.db,
    undefined as never,
    protection,
    new CoverageAccess(h.db, protection),
    new DeviceService(h.db, defaultRegistry(push)),
  );
});
afterAll(async () => {
  await h.close();
});

const req = (a: CoverageActor) => ({ headers: {}, coverageActor: a }) as never;
const OP: CoverageActor = { kind: 'OPS', sub: 'op-1', supervisor: false };
const SUP: CoverageActor = { kind: 'OPS', sub: 'sup-1', supervisor: true };
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status ?? (e as Error).message;
  }
};
const openEvent = async (kind = 'SOS') => {
  await h.signals.accept([sig(kind, { deviceId: WATCH, protectedPersonId: PERSON })]);
  await h.worker().drain();
  const [e] = await h.rows<{ id: string }>(
    `SELECT id FROM event.event WHERE protected_person_id = $1 AND state <> 'CLOSED'`,
    [PERSON],
  );
  return e!.id;
};
// audit.log yalnız eklenir (testler arası boşaltılmaz): olay kimliğiyle süzülür.
const audits = (eventId: string) =>
  h.rows<{ actor_kind: string; actor_id: string; entity_id: string; data: Record<string, unknown> }>(
    `SELECT actor_kind, actor_id, entity_id, data FROM audit.log
     WHERE action = 'device.command' AND data->>'eventId' = $1 ORDER BY id`,
    [eventId],
  );

describe('POST /devices/{id}/commands', () => {
  it('açık olay yokken RING / PROMPT / LOCATE 409; TEST gider', async () => {
    for (const type of ['RING', 'PROMPT', 'LOCATE'])
      expect(await status(controller.command(WATCH, { type }, req(OP)))).toBe(409);
    expect(await controller.command(WATCH, { type: 'TEST' }, req(OP))).toEqual({
      type: 'TEST',
      eventId: null,
      sent: true,
      outcome: 'sent',
    });
    expect(push.sent.map((m) => m.data)).toEqual([{ type: 'TEST' }]);
  });

  it('açık olayda: "Bu cihazı çaldır" (RING), "Soru gönder" (PROMPT), "Konum iste" (LOCATE); denetimde', async () => {
    const id = await openEvent('SOS');
    expect(await controller.command(WATCH, { type: 'RING' }, req(OP))).toEqual({
      type: 'RING',
      eventId: id,
      sent: true,
      outcome: 'sent',
    });
    expect(await controller.command(PHONE, { type: 'PROMPT', eventId: id }, req(SUP))).toMatchObject({ sent: true });
    expect(await controller.command(WATCH, { type: 'LOCATE' }, req(OP))).toMatchObject({ sent: true });
    expect(push.sent.map((m) => [m.deviceId, m.data.type, m.priority])).toEqual([
      [WATCH, 'RING', 'high'],
      [PHONE, 'PROMPT', 'high'],
      [WATCH, 'LOCATE', 'high'],
    ]);
    // SOS'un cihaz sorusu yok: kural paketi ladder.operatorPrompt (W-OP-PROMPT, 60 sn; telefonda P-OP-PROMPT), sesli
    const prompt = push.sent[1]!.data;
    expect(prompt).toMatchObject({
      eventId: id,
      kind: 'SOS',
      tts: 'W-OP-PROMPT',
      phoneTts: 'P-OP-PROMPT',
      windowSec: '60',
      silent: 'false',
    });
    expect(Date.parse(prompt.until!) - Date.now()).toBeGreaterThan(55_000);
    expect(await audits(id)).toEqual([
      {
        actor_kind: 'OPERATOR',
        actor_id: 'op-1',
        entity_id: WATCH,
        data: { type: 'RING', eventId: id, sent: true, outcome: 'sent' },
      },
      {
        actor_kind: 'OPERATOR',
        actor_id: 'sup-1',
        entity_id: PHONE,
        data: { type: 'PROMPT', eventId: id, sent: true, outcome: 'sent' },
      },
      {
        actor_kind: 'OPERATOR',
        actor_id: 'op-1',
        entity_id: WATCH,
        data: { type: 'LOCATE', eventId: id, sent: true, outcome: 'sent' },
      },
    ]);
  });

  it('düşme olayında soru düşme metniyle (W-FALL-1); başka olayın kimliği 409', async () => {
    const id = await openEvent('FALL');
    await controller.command(WATCH, { type: 'PROMPT' }, req(OP));
    expect(push.sent.at(-1)!.data).toMatchObject({ eventId: id, kind: 'FALL', tts: 'W-FALL-1' });
    expect(
      await status(
        controller.command(WATCH, { type: 'RING', eventId: '00000000-0000-0000-0000-0000000000ee' }, req(OP)),
      ),
    ).toBe(409);
  });

  it('yetki: aile ve cihaz 403, paylaşılan yönetici token’ı 403, OIDC yönetici olur; başka kişinin aile üyesi 404', async () => {
    await openEvent('SOS');
    expect(await status(controller.command(WATCH, { type: 'RING' }, req({ kind: 'FAMILY', sub: 'fam-alice' })))).toBe(
      403,
    );
    expect(await status(controller.command(WATCH, { type: 'RING' }, req({ kind: 'FAMILY', sub: 'fam-bob' })))).toBe(
      404,
    );
    expect(
      await status(
        controller.command(WATCH, { type: 'RING' }, req({ kind: 'DEVICE', personId: PERSON, deviceId: PHONE })),
      ),
    ).toBe(403);
    expect(await status(controller.command(WATCH, { type: 'RING' }, req({ kind: 'ADMIN' })))).toBe(403);
    expect(await status(controller.command(WATCH, { type: 'RING' }, req({ kind: 'ADMIN', sub: 'adm-1' })))).toBe('ok');
    expect(await status(controller.command('00000000-0000-0000-0000-00000000dead', { type: 'RING' }, req(OP)))).toBe(
      404,
    );
  });

  it('gövde doğrulama: bilinmeyen tür / alan, geçersiz olay kimliği 400', async () => {
    expect(await status(controller.command(WATCH, { type: 'CALL' }, req(OP)))).toBe(400);
    expect(await status(controller.command(WATCH, { type: 'RING', x: 1 }, req(OP)))).toBe(400);
    expect(await status(controller.command(WATCH, { type: 'RING', eventId: 'x' }, req(OP)))).toBe(400);
    expect(await status(controller.command(WATCH, null, req(OP)))).toBe(400);
  });
});

/** FCM sahte istemcisi: gönderilenleri tutar; `next` sonraki sonucu belirler. */
class FakeFcm {
  readonly sent: FcmMessage[] = [];
  next: FcmResult['status'] = 'ok';
  async send(m: FcmMessage): Promise<FcmResult> {
    this.sent.push(m);
    return this.next === 'ok' ? { status: 'ok', id: 'm' } : ({ status: this.next, reason: 'x' } as FcmResult);
  }
}

describe('gerçek teslim sonucu ve token’sız saate aktarım (DevicePush)', () => {
  let fcm: FakeFcm;
  beforeEach(() => {
    fcm = new FakeFcm();
    const protection = new ProtectionService(h.db, h.outbox);
    controller = new DeviceManageController(
      h.db,
      undefined as never,
      protection,
      new CoverageAccess(h.db, protection),
      new DeviceService(h.db, defaultRegistry(new DevicePush(h.db, null, undefined, fcm))),
    );
  });
  const tokens = (watch: string | null, phone: string | null) =>
    h.pg.query(
      `UPDATE device.device SET push_provider = CASE id WHEN $1 THEN $3 ELSE $4 END,
         push_token = CASE id WHEN $1 THEN $5 ELSE $6 END WHERE id IN ($1, $2)`,
      [WATCH, PHONE, watch ? 'FCM' : null, phone ? 'FCM' : null, watch, phone],
    );

  it('saatin token’ı yok, telefonunki var: RING / LOCATE / TEST / PROMPT telefona forDeviceId ile (data-only)', async () => {
    await tokens(null, 'tok-phone');
    const id = await openEvent('SOS');
    for (const type of ['RING', 'LOCATE', 'TEST', 'PROMPT'])
      expect(await controller.command(WATCH, { type }, req(OP))).toMatchObject({ sent: true, outcome: 'relayed' });
    expect(fcm.sent.map((m) => [m.token, m.data.type, m.data.forDeviceId, m.priority, m.body])).toEqual([
      ['tok-phone', 'RING', WATCH, 'high', undefined],
      ['tok-phone', 'LOCATE', WATCH, 'high', undefined],
      ['tok-phone', 'TEST', WATCH, 'normal', undefined],
      ['tok-phone', 'PROMPT', WATCH, 'high', undefined],
    ]);
    expect(fcm.sent[0]!.data).toEqual({ type: 'RING', eventId: id, forDeviceId: WATCH });
    expect((await audits(id)).map((a) => a.data.outcome)).toEqual(['relayed', 'relayed', 'relayed', 'relayed']);
  });

  it('hiçbir yol yoksa (saat ve telefon token’sız) sent false, outcome no-token; sağlayıcı hatası da false', async () => {
    await tokens(null, null);
    const id = await openEvent('SOS');
    expect(await controller.command(WATCH, { type: 'RING' }, req(OP))).toEqual({
      type: 'RING',
      eventId: id,
      sent: false,
      outcome: 'no-token',
    });
    expect(await controller.command(PHONE, { type: 'RING' }, req(OP))).toMatchObject({
      sent: false,
      outcome: 'no-token',
    });
    await tokens('tok-watch', null);
    fcm.next = 'retry';
    expect(await controller.command(WATCH, { type: 'RING' }, req(OP))).toMatchObject({ sent: false, outcome: 'retry' });
    fcm.next = 'ok';
    expect(await controller.command(WATCH, { type: 'RING' }, req(OP))).toMatchObject({ sent: true, outcome: 'sent' });
    expect((await audits(id)).map((a) => [a.data.sent, a.data.outcome])).toEqual([
      [false, 'no-token'],
      [false, 'no-token'],
      [false, 'retry'],
      [true, 'sent'],
    ]);
  });
});

describe('komut cevapları (sözleşme): TEST → TEST sinyali trigger OPERATOR; LOCATE → LOCATION trigger LOCATE', () => {
  const send = async (kind: string, extra: Record<string, unknown>) => {
    await h.signals.accept([sig(kind, { deviceId: WATCH, protectedPersonId: PERSON, ...extra })]);
    await h.worker().drain();
  };
  const events = () =>
    h.rows<{ id: string; type: string; location: { lat: number; source?: string } | null }>(
      `SELECT id::text AS id, type, location FROM event.event WHERE protected_person_id = $1 ORDER BY created_at`,
      [PERSON],
    );

  it('operatör testinin cevabı yeni TEST olayı açmaz, kayda geçer; kişinin kendi testi olay açar', async () => {
    await send('TEST', { payload: { trigger: 'OPERATOR' } });
    expect(await events()).toEqual([]);
    const [r] = await h.rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM signal.signal WHERE device_id = $1 AND kind = 'TEST'`,
      [WATCH],
    );
    expect(r!.n).toBe(1);
    await send('TEST', {});
    expect((await events()).map((e) => e.type)).toEqual(['TEST']);
  });

  it('LOCATE cevabı açık olayın konumunu her öncelikte günceller; başka olayın / tetiksiz konum P3+ olayda değiştirmez', async () => {
    await send('CALLBACK_REQUEST', {}); // P4 olay
    const [ev] = await events();
    expect(ev!.type).toBe('CALLBACK');
    await send('LOCATION', { location: { lat: 41.01, lng: 29.01, source: 'NETWORK' } });
    expect((await events())[0]!.location).toBeNull();
    await send('LOCATION', {
      location: { lat: 41.02, lng: 29.02, source: 'GPS' },
      payload: { trigger: 'LOCATE', eventId: '00000000-0000-0000-0000-0000000000ee' },
    });
    expect((await events())[0]!.location).toBeNull();
    await send('LOCATION', {
      location: { lat: 41.03, lng: 29.03, source: 'GPS' },
      payload: { trigger: 'LOCATE', eventId: ev!.id },
    });
    expect((await events())[0]!.location).toMatchObject({ lat: 41.03, source: 'GPS' });
  });
});
