import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { FieldCipher } from '../src/common/field-cipher';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import type { Actor } from '../src/modules/profile/contacts';
import { ProfileService } from '../src/modules/profile/profile.service';
import { nextDue, zonedToUtc } from '../src/modules/wellness/schedule';
import { spreadOffsetMin, WellnessService } from '../src/modules/wellness/wellness.service';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Düzenli "yanınızdayız" aramaları: plan → dönem satırı → zamanı gelince kişiye bildirim + operatöre P4 geri arama
 * → olay kapanınca sonuç; pencere dolarsa kaçırıldı + amir uyarısı; uyum oranı.
 */
const KEYS = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
const OWNER: Actor = { kind: 'FAMILY', id: 'fam-owner' };
const OP = 'op-1';

let h: Harness;
let events: EventService;
let profile: ProfileService;
let wellness: WellnessService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  events = h.events(new InMemoryTimers());
  profile = new ProfileService(h.db, new FieldCipher(KEYS), undefined, null);
  wellness = new WellnessService(h.db, h.outbox, events, profile);
  wellness.subscribe(bus);
});
afterAll(async () => {
  await h.close();
});

const person = async () => (await profile.create(OWNER, { displayName: 'Ayşe Y.', timezone: 'Europe/Istanbul' })).id;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status,
  );
const alerts = async () =>
  (
    await h.rows<{ envelope: { payload: { code: string } } }>(
      "SELECT envelope FROM event.outbox WHERE topic = 'supervisor.alert'",
    )
  ).map((r) => r.envelope.payload.code);

describe('zamanlama (saf)', () => {
  it('İstanbul yerel saati UTC+3; günlük, haftalık (Çarşamba), iki haftalık', () => {
    const tz = 'Europe/Istanbul';
    expect(zonedToUtc(2026, 11, 11, '11:00', tz).toISOString()).toBe('2026-11-11T08:00:00.000Z');
    const after = new Date('2026-11-11T09:00:00Z'); // Çarşamba 12:00 İstanbul
    expect(nextDue({ frequency: 'DAILY', weekday: 3, localTime: '11:00', timezone: tz }, after).toISOString()).toBe(
      '2026-11-12T08:00:00.000Z',
    );
    expect(nextDue({ frequency: 'WEEKLY', weekday: 3, localTime: '11:00', timezone: tz }, after).toISOString()).toBe(
      '2026-11-18T08:00:00.000Z',
    );
    const bi = nextDue({ frequency: 'BIWEEKLY', weekday: 3, localTime: '11:00', timezone: tz }, after);
    expect([new Date('2026-11-18T08:00:00Z').getTime(), new Date('2026-11-25T08:00:00Z').getTime()]).toContain(
      bi.getTime(),
    );
    // Yaz saati olan bölge: New York (Mart'ta UTC−4).
    expect(zonedToUtc(2026, 3, 9, '09:00', 'America/New_York').toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });
});

describe('plan ve dönemler', () => {
  it('sahip planı kurar (MEMBER 403), sıradaki dönem oluşur; geçersiz girdi 400', async () => {
    const id = await person();
    await h.pg.query(
      "INSERT INTO profile.family_member (id, protected_person_id, subject, role) VALUES (gen_random_uuid(), $1, 'fam-m', 'MEMBER')",
      [id],
    );
    expect(await status(wellness.setPlan({ kind: 'FAMILY', id: 'fam-m' }, id, { frequency: 'DAILY' }))).toBe(403);
    expect(await status(wellness.setPlan(OWNER, id, { localTime: '25:00' }))).toBe(400);
    const now = new Date('2026-11-11T05:00:00Z');
    const plan = await wellness.setPlan(OWNER, id, { frequency: 'DAILY', localTime: '11:00', channel: 'BOTH' }, now);
    expect(plan.nextDueAt).toBe('2026-11-11T08:00:00.000Z');
    const checks = await wellness.checks({ personId: id });
    expect(checks).toHaveLength(1);
    // Yayılma: planlanan saat + kişiye sabit kaydırma (pencerenin ilk yarısı, 120 dk → 0–59 dk).
    const due = Date.parse(checks[0]!.dueAt) - Date.parse('2026-11-11T08:00:00Z');
    expect(due).toBeGreaterThanOrEqual(0);
    expect(due).toBeLessThan(60 * 60_000);
    expect(checks[0]!.windowUntil).toBe('2026-11-11T10:00:00.000Z');
    expect(await status(wellness.plan({ kind: 'FAMILY', id: 'fam-m' }, id))).toBe(200); // üye okur
  });

  it('zamanı gelince kişiye bildirim + operatöre P4 geri arama; olay iyi kapanınca DONE_OK, sonraki dönem kurulur', async () => {
    const id = await person();
    await wellness.setPlan(
      OWNER,
      id,
      { frequency: 'DAILY', localTime: '11:00', channel: 'BOTH' },
      new Date('2026-11-11T05:00:00Z'),
    );
    const due = new Date('2026-11-11T09:01:00Z');
    await wellness.sweep(due);
    const [c] = await wellness.checks({ personId: id, status: ['IN_PROGRESS'] });
    expect(c).toMatchObject({ status: 'IN_PROGRESS' });
    const ev = await events.get(c!.eventId!);
    expect(ev).toMatchObject({ type: 'CALLBACK', priority: 4, state: 'OPERATOR_QUEUE' });
    const codes = (
      await h.rows<{ envelope: { payload: { code: string; audience: string } } }>(
        "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested'",
      )
    ).map((r) => `${r.envelope.payload.audience}:${r.envelope.payload.code}`);
    expect(codes).toContain('ELDER:P-WELLNESS');

    await events.claim(ev.id, OP);
    await events.closeByOperator(ev.id, OP, 'OK', 'iyi, sohbet edildi');
    await h.worker().drain();
    expect((await wellness.checks({ personId: id, status: ['DONE_OK'] }))[0]).toMatchObject({ operatorId: OP });
    await wellness.sweep(due);
    const next = await wellness.checks({ personId: id, status: ['SCHEDULED'] });
    expect(next).toHaveLength(1);
    expect(next[0]!.windowUntil).toBe('2026-11-12T10:00:00.000Z');
  });

  it('pencere dolarsa KAÇIRILDI + amire O-WELLNESS-MISSED; uyum oranı düşer', async () => {
    const id = await person();
    await wellness.setPlan(
      OWNER,
      id,
      { frequency: 'DAILY', localTime: '11:00', windowMin: 60 },
      new Date('2026-11-11T05:00:00Z'),
    );
    await wellness.sweep(new Date('2026-11-11T08:01:00Z'));
    await wellness.sweep(new Date('2026-11-11T09:01:00Z'));
    expect((await wellness.checks({ personId: id, status: ['MISSED'] })).length).toBe(1);
    expect(await alerts()).toContain('O-WELLNESS-MISSED');
    const c = await wellness.compliance(id, 30, new Date('2026-11-11T12:00:00Z'));
    expect(c).toMatchObject({ planned: 1, missed: 1, ratio: 0 });
    // Denetim bulgu 7: kuyrukta bekleyen P4 geri arama olayı sistemce kapanır (sonraki tespitleri yutmasın).
    const open = await h.rows("SELECT id FROM event.event WHERE protected_person_id = $1 AND state <> 'CLOSED'", [id]);
    expect(open).toEqual([]);
    const [closed] = await h.rows<{ confirmed_outcome: string }>(
      'SELECT confirmed_outcome FROM event.event WHERE protected_person_id = $1',
      [id],
    );
    expect(closed!.confirmed_outcome).toBe('SUPPRESSED');
  });

  it('yalnız bildirim kanalı: geri arama açılmaz, NOTIFIED; plan kapatılınca yeni dönem yok', async () => {
    const id = await person();
    await wellness.setPlan(
      OWNER,
      id,
      { frequency: 'DAILY', localTime: '11:00', channel: 'NOTIFY' },
      new Date('2026-11-11T05:00:00Z'),
    );
    await wellness.sweep(new Date('2026-11-11T09:01:00Z'));
    expect(await events.all()).toEqual([]);
    expect((await wellness.checks({ personId: id, status: ['NOTIFIED'] })).length).toBe(1);
    await wellness.setPlan(OWNER, id, { enabled: false }, new Date('2026-11-11T09:00:00Z'));
    await wellness.sweep(new Date('2026-11-12T09:00:00Z'));
    expect(await wellness.checks({ personId: id, status: ['SCHEDULED'] })).toEqual([]);
  });

  it('süren olay varken dönem SKIPPED (OPEN_EVENT) ve SOS olayına karışmaz; uyum paydasına girmez', async () => {
    const id = await person();
    await wellness.setPlan(OWNER, id, { frequency: 'DAILY', localTime: '11:00' }, new Date('2026-11-11T05:00:00Z'));
    await bus.deliver('signal.received', { payload: sig('SOS', { protectedPersonId: id }) } as never);
    const sos = (await events.all())[0]!;
    await wellness.sweep(new Date('2026-11-11T09:01:00Z'));
    const [c] = await wellness.checks({ personId: id, status: ['SKIPPED'] });
    expect(c).toMatchObject({ outcome: 'OPEN_EVENT', eventId: null });
    expect((await events.get(sos.id)).sourceSignalIds).toHaveLength(1);
    expect((await wellness.compliance(id, 30, new Date('2026-11-11T12:00:00Z'))).ratio).toBe(1);
  });

  it('operatör görüşürken pencere dolsa KAÇIRILDI yazılmaz; kapanınca DONE_OK', async () => {
    const id = await person();
    await wellness.setPlan(
      OWNER,
      id,
      { frequency: 'DAILY', localTime: '11:00', windowMin: 60 },
      new Date('2026-11-11T05:00:00Z'),
    );
    await wellness.sweep(new Date('2026-11-11T08:31:00Z'));
    const [c] = await wellness.checks({ personId: id, status: ['IN_PROGRESS'] });
    await events.claim(c!.eventId!, OP);
    await wellness.sweep(new Date('2026-11-11T09:05:00Z'));
    expect((await wellness.checks({ personId: id, status: ['IN_PROGRESS'] })).length).toBe(1);
    await events.closeByOperator(c!.eventId!, OP, 'OK');
    await h.worker().drain();
    expect((await wellness.checks({ personId: id, status: ['DONE_OK'] })).length).toBe(1);
  });

  it('ulaşılamadı → 30 dk sonra bir kez daha; yine ulaşılamazsa KAÇIRILDI + aileye F-WELLNESS-MISSED', async () => {
    const id = await person();
    await wellness.setPlan(
      OWNER,
      id,
      { frequency: 'DAILY', localTime: '11:00', channel: 'CALL' },
      new Date('2026-11-11T05:00:00Z'),
    );
    await wellness.sweep(new Date('2026-11-11T09:01:00Z'));
    let [c] = await wellness.checks({ personId: id, status: ['IN_PROGRESS'] });
    await events.claim(c!.eventId!, OP);
    await events.closeByOperator(c!.eventId!, OP, 'UNREACHABLE');
    await h.worker().drain();
    const retry = (await wellness.checks({ personId: id, status: ['SCHEDULED'] })).find((x) => x.id === c!.id)!;
    expect(retry).toMatchObject({ outcome: 'UNREACHABLE', eventId: null });
    await wellness.sweep(new Date(Date.parse(retry.dueAt) + 60_000));
    [c] = await wellness.checks({ personId: id, status: ['IN_PROGRESS'] });
    expect(c!.id).toBe(retry.id);
    await events.claim(c!.eventId!, OP);
    await events.closeByOperator(c!.eventId!, OP, 'UNREACHABLE');
    await h.worker().drain();
    expect((await wellness.checks({ personId: id, status: ['MISSED'] }))[0]).toMatchObject({ id: c!.id });
    const codes = (
      await h.rows<{ envelope: { payload: { code: string; audience: string } } }>(
        "SELECT envelope FROM event.outbox WHERE topic = 'notify.requested'",
      )
    ).map((r) => `${r.envelope.payload.audience}:${r.envelope.payload.code}`);
    expect(codes).toContain('FAMILY:F-WELLNESS-MISSED');
  });

  it('kuyrukta P1 bekliyorken düzenli arama ertelenir (dönemin ikinci yarısına kadar)', async () => {
    const id = await person();
    await wellness.setPlan(
      OWNER,
      id,
      { frequency: 'DAILY', localTime: '11:00', windowMin: 120 },
      new Date('2026-11-11T05:00:00Z'),
    );
    await bus.deliver('signal.received', { payload: sig('SOS', { protectedPersonId: 'baska-kisi' }) } as never);
    await wellness.sweep(new Date('2026-11-11T09:01:00Z'));
    expect(await wellness.checks({ personId: id, status: ['IN_PROGRESS'] })).toEqual([]);
    expect((await wellness.checks({ personId: id, status: ['SCHEDULED'] })).length).toBe(1);
    await wellness.sweep(new Date('2026-11-11T09:35:00Z')); // ikinci yarı (≤ 09:30'dan sonra): yine başlar
    expect((await wellness.checks({ personId: id, status: ['IN_PROGRESS'] })).length).toBe(1);
  });

  it('yayılma: farklı kişiler farklı kaydırma, aynı kişi hep aynı', () => {
    const offs = new Set(
      Array.from({ length: 20 }, (_, i) =>
        spreadOffsetMin(`01960000-0000-7000-8000-${String(i).padStart(12, '0')}`, 120),
      ),
    );
    expect(offs.size).toBeGreaterThan(5);
    expect(spreadOffsetMin('x', 120)).toBe(spreadOffsetMin('x', 120));
  });
});
