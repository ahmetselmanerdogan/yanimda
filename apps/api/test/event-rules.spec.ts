import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import { createHarness, type Harness, sig } from './support/harness';

/** T-012 · D-02 olay üretimi: açık olayda SOS, saat çıkarma bekleme akışı, pil bildirimleri, cihaz taraması. */
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

const deliver = (s: ReturnType<typeof sig>) =>
  bus.deliver<Signal>('signal.received', { payload: s } as unknown as KafkaEnvelope<Signal>);
const only = async () => {
  const all = await events.all();
  expect(all).toHaveLength(1);
  return events.get(all[0].id);
};
const notices = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string; audience: string; protectedPersonId: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested' ORDER BY id",
    )
  ).map(({ envelope: { payload: p } }) => ({
    code: p.code,
    audience: p.audience,
    protectedPersonId: p.protectedPersonId,
  }));

describe('Açık olay varken SOS (D-02 adım 3)', () => {
  it('FALL sorusu sürerken SOS → öncelik 1, hemen yükseltilir, soru zamanlayıcısı silinir', async () => {
    await deliver(sig('FALL'));
    const fall = await only();
    expect(timers.pendingIds()).toEqual([`${fall.id}.prompt-expire`]);
    await deliver(sig('SOS'));
    const ev = await only();
    expect(ev).toMatchObject({ type: 'FALL', priority: 1, state: 'OPERATOR_QUEUE' });
    expect(ev.sourceSignalIds).toHaveLength(2);
    expect(ev.transitions.find((t) => t.to === 'ESCALATED')!.note).toBe('SOS geldi');
    expect(timers.pendingIds()).toEqual([]);
  });

  it('saat çıkarıldı (P3) olayı açıkken SOS → öncelik 1 ve kuyruğa', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T11:00:00Z' })); // 14:00 İstanbul
    expect((await only()).priority).toBe(3);
    await deliver(sig('SOS'));
    expect(await only()).toMatchObject({ priority: 1, state: 'OPERATOR_QUEUE' });
    const audit = await h.rows<{ action: string; data: { from: number; to: number } }>(
      "SELECT action, data FROM audit.log WHERE action = 'event.priority_raised' ORDER BY id DESC LIMIT 1",
    );
    expect(audit[0].data).toMatchObject({ from: 3, to: 1 });
  });

  it("kuyruktaki olaya SOS → öncelik 1 (durum aynı kalır, not audit'e)", async () => {
    await deliver(sig('CALLBACK_REQUEST'));
    expect(await only()).toMatchObject({ priority: 4, state: 'OPERATOR_QUEUE' });
    await deliver(sig('SOS'));
    expect(await only()).toMatchObject({ priority: 1, state: 'OPERATOR_QUEUE' });
    const topics = (await h.rows<{ topic: string }>('SELECT topic FROM event.outbox')).map((r) => r.topic);
    expect(topics).toContain('event.updated');
  });

  it('alarm olmayan olaya FALL → olay FALL alarmına yükseltilir (bkz. event-upgrade.spec)', async () => {
    await deliver(sig('CALLBACK_REQUEST'));
    await deliver(sig('FALL'));
    expect(await only()).toMatchObject({ priority: 1, type: 'FALL' });
    expect((await only()).sourceSignalIds).toHaveLength(2);
  });
});

describe('Saat çıkarıldı (WATCH_OFF) bekleme akışı', () => {
  const day = '2026-11-08T11:00:00Z'; // 14:00 İstanbul

  it('OFF_BODY (gündüz) → bekleme; 120 dk hatırlatma, 240 dk operatör zamanlayıcıları', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: day }));
    const ev = await only();
    expect(ev.state).toBe('DEVICE_PROMPT');
    expect(timers.delayOf(`${ev.id}.watch-off-remind`)).toBe(120 * 60_000);
    expect(timers.delayOf(`${ev.id}.watch-off-operator`)).toBe(240 * 60_000);
  });

  it('120 dk: kişiye P-WATCH-OFF-2H hatırlatması (durum aynı)', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: day }));
    const ev = await only();
    await timers.fire(ev.id, 'watch-off-remind');
    expect((await only()).state).toBe('DEVICE_PROMPT');
    expect(await notices()).toEqual([{ code: 'P-WATCH-OFF-2H', audience: 'ELDER', protectedPersonId: 'pp-1' }]);
  });

  it('240 dk: operatöre düşer', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: day }));
    const ev = await only();
    await timers.fire(ev.id, 'watch-off-operator');
    expect((await only()).state).toBe('OPERATOR_QUEUE');
  });

  it('saat takılınca (ON_BODY) kapanır, zamanlayıcılar silinir', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: day }));
    await deliver(sig('ON_BODY'));
    expect((await only()).state).toBe('CLOSED');
    expect(timers.pendingIds()).toEqual([]);
  });

  it('gece penceresinde OFF_BODY olay üretmez (kişi saat dilimi)', async () => {
    await deliver(sig('OFF_BODY', { occurredAt: '2026-11-08T20:00:00Z' })); // 23:00 İstanbul
    expect(await events.all()).toEqual([]);
  });

  it('kişinin saat dilimi profilden okunur', async () => {
    await h.pg.exec(`INSERT INTO profile.protected_person (id, display_name, timezone)
      VALUES ('00000000-0000-0000-0000-0000000000aa', 'NY', 'America/New_York')`);
    // 20:00Z = 15:00 New York (gündüz) ama 23:00 İstanbul (gece)
    await deliver(
      sig('OFF_BODY', {
        protectedPersonId: '00000000-0000-0000-0000-0000000000aa',
        occurredAt: '2026-11-08T20:00:00Z',
      }),
    );
    expect(await events.all()).toHaveLength(1);
  });
});

describe('Pil bildirimleri (olay yok)', () => {
  it('BATTERY 20 → kişiye W-BAT-20; BATTERY 10 → kişiye W-BAT-10 + aileye F-BAT-10', async () => {
    await deliver(sig('BATTERY', { value: 20 }));
    await deliver(sig('BATTERY', { value: 10 }));
    expect(await events.all()).toEqual([]);
    expect((await notices()).map((n) => `${n.code}/${n.audience}`)).toEqual([
      'W-BAT-20/ELDER',
      'W-BAT-10/ELDER',
      'F-BAT-10/FAMILY',
    ]);
  });

  it('aynı pil sinyali yeniden teslim edilirse aynı dedupeKey taşır (tüketici ayıklar, T-053)', async () => {
    const s = sig('BATTERY', { value: 10 });
    await deliver(s);
    await deliver(s);
    const keys = (
      await h.rows<{ k: string }>(
        "SELECT envelope->'payload'->>'dedupeKey' AS k FROM event.outbox WHERE topic = 'notify.requested'",
      )
    ).map((r) => r.k);
    expect(keys).toHaveLength(4);
    expect(new Set(keys)).toEqual(
      new Set([`signal:${s.idempotencyKey}:W-BAT-10`, `signal:${s.idempotencyKey}:F-BAT-10`]),
    );
  });
});

// T-086: cihaz taraması (BATTERY_DEAD 120 dk / CONNECTION_LOST 6 sa) kaldırıldı; pili biten saat ve bağlantı kopması
// artık KAPSAMA BOŞLUĞU'nun nedenleridir (docs/07 S4.7, S8.2). Yerini alan testler: coverage-charging.spec.ts.

describe('Cihaz sorusu cevabı soruya bağlıdır (bulgu 9)', () => {
  it('soru açılmadan önce sunucuya ulaşmış (geciken / yeniden teslim) CANCEL yeni FALL olayını iptal etmez', async () => {
    const stale = sig('CANCEL', { receivedAt: new Date(Date.now() - 60_000).toISOString() });
    await deliver(sig('FALL'));
    const fall = await only();
    expect(fall.state).toBe('DEVICE_PROMPT');
    await deliver(stale);
    expect((await only()).state).toBe('DEVICE_PROMPT');
    const [a] = await h.rows<{ data: { reason: string } }>(
      "SELECT data FROM audit.log WHERE action = 'event.answer_ignored' AND entity_id = $1",
      [fall.id],
    );
    expect(a!.data.reason).toBe('BEFORE_PROMPT');
    // Sorudan sonra gelen cevap geçerli.
    await deliver(sig('CANCEL', { receivedAt: new Date(Date.now() + 1000).toISOString() }));
    expect((await only()).state).toBe('CLOSED');
  });

  it('başka olaya ait cevap (payload.eventId) yok sayılır; aynı olayınki kapatır', async () => {
    await deliver(sig('FALL'));
    const fall = await only();
    await deliver(sig('OK', { payload: { eventId: '00000000-0000-7000-8000-000000000999' } }));
    expect((await only()).state).toBe('DEVICE_PROMPT');
    await deliver(sig('OK', { payload: { eventId: fall.id } }));
    expect((await only()).state).toBe('CLOSED');
  });
});
