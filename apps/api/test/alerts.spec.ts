import type { KafkaEnvelope, Signal } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '../src/common/bus';
import { InMemoryTimers } from '../src/common/timers/memory-timers';
import type { EventService } from '../src/modules/event/event.service';
import { AlertsService } from '../src/modules/metrics/alerts.service';
import { claimSlaSec } from '../src/modules/metrics/sla';
import { createHarness, type Harness, sig } from './support/harness';

/**
 * Kalıcı amir uyarıları (gece karar 2): her supervisor.alert kalıcı, tekrar teslimde tek; "gördüm" audit'li; öncelik
 * bazlı üstlenme hedefi aşılınca kuyruğa her girişte tek O-QUEUE-UNCLAIMED.
 */
let h: Harness;
let events: EventService;
let alerts: AlertsService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  events = h.events(new InMemoryTimers());
  alerts = new AlertsService(h.db, h.outbox);
  alerts.subscribe(bus);
});
afterAll(async () => {
  await h.close();
});
const deliver = (kind: string, person: string) =>
  bus.deliver<Signal>('signal.received', {
    payload: sig(kind, { protectedPersonId: person }),
  } as unknown as KafkaEnvelope<Signal>);

describe('kalıcı amir uyarıları', () => {
  it('öncelik hedefleri: P1 10 sn, P2 30 sn, P3 2 dk, P4 10 dk', () => {
    expect([1, 2, 3, 4].map(claimSlaSec)).toEqual([10, 30, 120, 600]);
  });

  it('P1 hedefi aşınca tek O-QUEUE-UNCLAIMED (tekrar taramada yok); P4 1 dk beklerken yok', async () => {
    await deliver('SOS', 'pp-a');
    await deliver('CALLBACK_REQUEST', 'pp-b');
    const later = new Date(Date.now() + 60_000);
    expect(await alerts.sweep(later)).toBe(1);
    expect(await alerts.sweep(later)).toBe(0);
    await h.worker().drain(); // çekirdek şerit kaydı tekrar teslim gibi: aynı anahtar → tek satır
    const open = await alerts.list({ open: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ code: 'O-QUEUE-UNCLAIMED', eventType: 'SOS' });
    expect(await alerts.sweep(new Date(Date.now() + 11 * 60_000))).toBe(1); // P4 10 dk sonra
  });

  it('kilit düştü uyarısı outbox üzerinden kalıcı olur; gördüm audit, ikinci kez 409, olmayan 404', async () => {
    await deliver('SOS', 'pp-c');
    const [ev] = await events.all();
    await events.claim(ev!.id, 'op-1');
    await h.pg.query("UPDATE event.event SET lock_until = now() - interval '1 minute' WHERE id = $1", [ev!.id]);
    await events.releaseExpiredLocks();
    await h.worker().drain();
    await h.worker().drain();
    const [a] = (await alerts.list({ open: true })).filter((x) => x.code === 'O-LOCK-LOST');
    expect(a).toMatchObject({ eventId: ev!.id, operatorId: 'op-1' });
    const acked = await alerts.ack(a!.id, 'sup-1');
    expect(acked).toMatchObject({ ackedBy: 'sup-1' });
    expect((await alerts.list({ open: true })).find((x) => x.id === a!.id)).toBeUndefined();
    await expect(alerts.ack(a!.id, 'sup-1')).rejects.toMatchObject({ status: 409 });
    await expect(alerts.ack('01960000-0000-7000-8000-00000000ffff', 'sup-1')).rejects.toMatchObject({ status: 404 });
    const audit = await h.rows(
      "SELECT actor_id FROM audit.log WHERE action = 'supervisor.alert_acked' AND entity_id = $1",
      [a!.id],
    );
    expect(audit).toEqual([{ actor_id: 'sup-1' }]);
  });
});
