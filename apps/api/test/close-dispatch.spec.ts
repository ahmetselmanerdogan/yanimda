import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import { ChainService } from '../src/modules/chain/chain.service';
import { loadProcedures } from '../src/modules/chain/procedures';
import type { EventService } from '../src/modules/event/event.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * T-024 kapatma ve 112 şablonu (E-06, E-07). Kabul:
 *  - EMERGENCY kapatınca 24 saat sonra FOLLOW_UP olayı oluşur (zamanlayıcı enjekte), P4 kuyrukta
 *  - kapatma: sonuç zorunlu, not ≤ 2000, takip araması isteğe bağlı (EMERGENCY'de zorunlu)
 *  - şablon tüm alanları doldurur, boş alan "bilinmiyor"; yalnız olayı yürüten operatöre
 */
const PERSON = '00000000-0000-0000-0000-0000000000c1';
let h: Harness;
let timers: InMemoryTimers;
let events: EventService;
let chain: ChainService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  timers = new InMemoryTimers();
  events = h.events(timers);
  chain = new ChainService(h.db, events, loadProcedures());
});
afterAll(async () => {
  await h.close();
});

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
async function claimed(person = 'pp-1', kind = 'SOS', extra: Record<string, unknown> = {}) {
  await deliver(sig(kind, { protectedPersonId: person, ...extra }));
  const [{ id, state }] = await h.rows<{ id: string; state: string }>(
    "SELECT id, state FROM event.event WHERE protected_person_id = $1 AND state <> 'CLOSED'",
    [person],
  );
  if (state === 'DEVICE_PROMPT') await timers.fire(id, 'prompt-expire'); // cevap yok → kuyruk
  await chain.claim(id, 'op-1');
  return id;
}
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

describe('kapatma ve takip araması', () => {
  it('EMERGENCY → varsayılan 24 saat; tetiklenince FOLLOW_UP P4 kuyrukta', async () => {
    const id = await claimed();
    await chain.escalate112(id, 'op-1', { reason: 'düştü, kalkamıyor' });
    await chain.stepResult(id, 4, 'op-1', { result: 'REACHED' });
    await chain.close(id, 'op-1', { outcome: 'EMERGENCY', note: 'ambulans yolda' });
    expect(timers.delayOf(`${id}.follow-up`)).toBe(24 * 3600 * 1000);
    await timers.fire(id, 'follow-up');
    const fu = (await events.queuePage({ limit: 50, offset: 0 })).items.filter((i) => i.type === 'FOLLOW_UP');
    expect(fu).toHaveLength(1);
    expect(fu[0]).toMatchObject({ priority: 4, state: 'OPERATOR_QUEUE' });
    const [a] = await h.rows<{ data: { hours: number } }>(
      "SELECT data FROM audit.log WHERE action = 'event.follow_up_planned' AND entity_id = $1",
      [id],
    );
    expect(a!.data).toEqual({ hours: 24 });
  });

  it('EMERGENCY özel süre; diğer sonuçlarda istenirse planlanır, istenmezse planlanmaz', async () => {
    const a = await claimed('pp-a');
    await chain.close(a, 'op-1', { outcome: 'EMERGENCY', followUpAfterHours: 6 });
    expect(timers.delayOf(`${a}.follow-up`)).toBe(6 * 3600 * 1000);

    const b = await claimed('pp-b');
    await chain.close(b, 'op-1', { outcome: 'UNREACHABLE', followUpAfterHours: 2 });
    expect(timers.delayOf(`${b}.follow-up`)).toBe(2 * 3600 * 1000);

    const c = await claimed('pp-c');
    await chain.close(c, 'op-1', { outcome: 'FALSE_ALARM' });
    expect(timers.pendingIds()).not.toContain(`${c}.follow-up`);
  });

  it('doğrulama: sonuç zorunlu/geçerli, not ≤ 2000, takip 1–168 tamsayı', async () => {
    const id = await claimed();
    expect(await status(chain.close(id, 'op-1', {}))).toBe(400);
    expect(await status(chain.close(id, 'op-1', { outcome: 'BELKI' }))).toBe(400);
    expect(await status(chain.close(id, 'op-1', { outcome: 'OK', note: 'x'.repeat(2001) }))).toBe(400);
    for (const bad of [0, 169, 1.5, '24'])
      expect(await status(chain.close(id, 'op-1', { outcome: 'OK', followUpAfterHours: bad }))).toBe(400);
    expect((await events.get(id)).state).toBe('OPERATOR_ASSIGNED'); // hiçbiri yazılmadı
    expect(await status(chain.close(id, 'op-1', { outcome: 'OK', note: 'x'.repeat(2000) }))).toBe('ok');
  });
});

describe('112 şablonu', () => {
  it('kişi, yaş, tip ve konum dolar; bilinmeyen alanlar "bilinmiyor"; erişim audit’e içeriksiz', async () => {
    await h.pg.exec(
      `INSERT INTO profile.protected_person (id, display_name, birth_year) VALUES ('${PERSON}', 'Hatice K.', 1944)`,
    );
    const id = await claimed(PERSON, 'FALL', { location: { lat: 41.0123456, lng: 29.0654321 } });
    const s = await chain.dispatchScript(id, 'op-1', 'dispatch112');
    expect(s.fields).toEqual({
      type: 'Düşme',
      name: 'Hatice K.',
      age: String(new Date().getUTCFullYear() - 1944),
      address: '41.01235, 29.06543',
      conditions: 'bilinmiyor',
      medications: 'bilinmiyor',
      allergies: 'bilinmiyor',
      doorNote: 'bilinmiyor',
    });
    expect(s.text).toContain('Kişi: Hatice K.');
    expect(s.text).not.toMatch(/\{\w+\}/);
    const audit = await h.rows<{ data: unknown }>("SELECT data FROM audit.log WHERE action = 'event.script_viewed'");
    expect(audit.map((a) => a.data)).toEqual([{ kind: 'dispatch112' }]);
  });

  it('profil yoksa tüm kişi alanları "bilinmiyor"', async () => {
    const id = await claimed('pp-yok');
    const s = await chain.dispatchScript(id, 'op-1', 'dispatch112');
    expect(Object.values(s.fields).filter((v) => v === 'bilinmiyor')).toHaveLength(7);
  });

  it('yalnız olayı yürüten operatör (409); bilinmeyen şablon 400; okundu zaman damgası adıma', async () => {
    const id = await claimed();
    expect(await status(chain.dispatchScript(id, 'op-2', 'dispatch112'))).toBe(409);
    expect(await status(chain.dispatchScript(id, 'op-1', 'baska'))).toBe(400);
    const at = new Date();
    const r = await chain.scriptRead(id, 4, 'op-1', at);
    expect(r.chain!.steps[3]).toMatchObject({ kind: 'CALL_112', scriptReadAt: at.toISOString() });
  });
});
