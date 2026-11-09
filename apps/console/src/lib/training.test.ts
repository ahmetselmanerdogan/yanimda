import { describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from './live';
import { trainingRequested, TrainingSim } from './training';

describe('eğitim modu (T-026)', () => {
  it('yalnız ?training=1 ve üretim dışında', () => {
    expect(trainingRequested('?training=1', false)).toBe(true);
    expect(trainingRequested('?training=1', true)).toBe(false); // üretimde kapalı
    expect(trainingRequested('', false)).toBe(false);
  });

  it('başlangıç olayları, üstlen → zincir, sıra dışı 409, cevap yok, 112 kısayolu, acil kapatma; ağ yok', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sim = new TrainingSim();
    sim.start(0, ['SOS', 'FALL']);
    const msgs: ServerMessage[] = [];
    sim.connect({ onStatus: () => undefined, onMessage: (m) => msgs.push(m) });
    const snap = msgs.find((m) => m.type === 'snapshot') as Extract<ServerMessage, { type: 'snapshot' }>;
    expect(snap.items.map((i) => i.type)).toEqual(['SOS', 'FALL']);

    const id = snap.items[0]!.eventId;
    const c = await sim.api.claim(id);
    expect(c.event.state).toBe('OPERATOR_ASSIGNED');
    expect(c.chain!.steps.map((s) => s.kind)).toEqual(['CALL_WATCH', 'CALL_PHONE', 'CALL_CONTACT', 'CALL_112']);
    await expect(sim.api.result(id, 3, { result: 'NO_ANSWER' })).rejects.toMatchObject({ status: 409 });
    await expect(sim.api.result(id, 1, { result: 'SKIPPED' })).rejects.toMatchObject({ status: 400 });
    expect((await sim.api.result(id, 1, { result: 'NO_ANSWER' })).chain!.current).toBe(2);
    const e = await sim.api.escalate(id, 'sessiz hat');
    expect(e.event.state).toBe('CONFIRMED_EMERGENCY');
    expect(e.chain!.current).toBe(4);
    expect((await sim.api.dispatchScript(id)).text).toContain('Tatbikat kişisi 1');
    expect((await sim.api.result(id, 4, { result: 'REACHED' })).event.state).toBe('DISPATCH');
    await expect(sim.api.close(id, 'OK')).rejects.toMatchObject({ status: 409 });
    await sim.api.close(id, 'EMERGENCY');
    expect(msgs.at(-1)).toEqual({ type: 'remove', eventId: id });
    expect((await sim.api.queue()).total).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-051 tatbikat araması: Ara → çalıyor → görüşme; beklet, aile ekle, bitir → Ulaşıldı önerisi; ağ yok', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sim = new TrainingSim('egitim', 0);
    sim.start(0, ['SOS']);
    const msgs: ServerMessage[] = [];
    sim.connect({ onStatus: () => undefined, onMessage: (m) => msgs.push(m) });
    const id = (msgs.find((m) => m.type === 'snapshot') as Extract<ServerMessage, { type: 'snapshot' }>).items[0]!
      .eventId;
    await sim.api.claim(id);
    expect((await sim.api.telephonyToken()).provider).toBe('fake');
    const r = await sim.api.call(id, 1);
    const c = r.calls![0]!;
    expect(c).toMatchObject({ stepN: 1, status: 'ringing' });
    await expect(sim.api.hold(c.id, true)).rejects.toMatchObject({ status: 409 });
    await sim.api.call(id, 1); // süren aramada ikinci arama yok
    await new Promise((res) => setTimeout(res, 5));
    expect((await sim.api.event(id)).calls).toEqual([expect.objectContaining({ status: 'in-progress' })]);
    expect(await sim.api.hold(c.id, true)).toMatchObject({ held: true, conference: true });
    expect(await sim.api.conference(c.id)).toMatchObject({ parties: 1 });
    expect(await sim.api.hangup(c.id)).toMatchObject({ status: 'completed', suggestedResult: 'REACHED', held: false });
    await expect(sim.api.hangup('yok')).rejects.toMatchObject({ status: 404 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
