import type { SupervisorAlert } from '@yanimda/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type PushSender, WebPushService } from '../src/modules/webpush/webpush.service';
import { createHarness, type Harness } from './support/harness';

/** Personel web push: abonelik, amir uyarısı yalnız SUPERVISOR'a, yükte PII yok, 410 aboneliği siler. */
let h: Harness;
let sent: { endpoint: string; payload: string }[];
let fail: Record<string, number>;
let push: WebPushService;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  sent = [];
  fail = {};
  const sender: PushSender & { publicKey: string } = {
    publicKey: 'BPub',
    send: async (sub, payload) => {
      if (fail[sub.endpoint]) throw Object.assign(new Error('x'), { statusCode: fail[sub.endpoint] });
      sent.push({ endpoint: sub.endpoint, payload });
    },
  };
  push = new WebPushService(h.db, sender);
});
afterAll(async () => {
  await h.close();
});
const keys = { p256dh: 'p', auth: 'a' };
const alert: SupervisorAlert = {
  code: 'O-DISPATCH-NO-ARRIVAL',
  eventId: 'e1',
  eventType: 'SOS',
  at: new Date().toISOString(),
};

describe('web push', () => {
  it('amir uyarısı yalnız SUPERVISOR aboneliğine; yük katalog metni, kişi adı yok; acil işaretli', async () => {
    await push.register('sup-1', ['SUPERVISOR'], { endpoint: 'https://push.example/s1', keys });
    await push.register('op-1', ['OPERATOR'], { endpoint: 'https://push.example/o1', keys });
    expect(await push.onAlert(alert)).toBe(1);
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example/s1']);
    const p = JSON.parse(sent[0]!.payload) as { body: string; urgent: boolean; url: string };
    expect(p).toMatchObject({ urgent: true, url: '/supervisor' });
    expect(p.body).toContain('SOS');
  });

  it('410 dönen abonelik silinir; geçersiz endpoint 400; bırakma', async () => {
    await push.register('sup-1', ['SUPERVISOR'], { endpoint: 'https://push.example/gone', keys });
    fail['https://push.example/gone'] = 410;
    expect(await push.onAlert(alert)).toBe(0);
    expect(await h.rows('SELECT 1 FROM identity.web_push_subscription')).toEqual([]);
    await expect(push.register('sup-1', ['SUPERVISOR'], { endpoint: 'http://x', keys })).rejects.toMatchObject({
      status: 400,
    });
    await push.register('sup-1', ['SUPERVISOR'], { endpoint: 'https://push.example/s2', keys });
    await push.unregister('sup-1', 'https://push.example/s2');
    expect(await h.rows('SELECT 1 FROM identity.web_push_subscription')).toEqual([]);
  });

  it('VAPID yoksa kapalı: gönderim yok', async () => {
    const off = new WebPushService(h.db, null);
    expect(off.enabled).toBe(false);
    expect(await off.onAlert(alert)).toBe(0);
  });
});
