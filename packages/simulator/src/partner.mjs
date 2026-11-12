// T-085 OEM: sahte ortak merkezi (FAKE_PENDANT). Hücresel / radyo kolye olaylarını imzalı webhook olarak gönderir
// (POST /v1/webhooks/partners/FAKE_PENDANT). Üretici cihazı önce kişiye bağlanmış olmalı (POST /v1/vendor-links,
// amir). Sır API ile aynı ortam değişkeninden: PARTNER_FAKE_PENDANT_WEBHOOK_SECRET.
// İmza: X-Partner-Signature v1=<hex> = HMAC-SHA256(sır, "<unix sn>.<nonce>.<ham gövde>").
import { createHmac, randomUUID } from 'node:crypto';

export const PARTNER = 'FAKE_PENDANT';

export function partnerSignature(secret, ts, nonce, body) {
  return `v1=${createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex')}`;
}

/** Üretici olayı (type: SOS | FALL | CANCEL | BATTERY | HEARTBEAT | WORN | NOT_WORN | POWER | LINE | BUTTON_TEST | LOCATION). */
export const pendantEvent = (type, device, extra = {}) => ({
  id: `sim-${randomUUID()}`,
  type,
  device,
  at: new Date().toISOString(),
  ...extra,
});

/** Olayları imzalayıp gönderir; yanıt { status, body }. Kalıcı ret `body.rejected` içinde (üretici olay kimliğiyle). */
export async function sendPartnerEvents({
  api = process.env.API_URL ?? 'http://localhost:3000/v1',
  secret = process.env.PARTNER_FAKE_PENDANT_WEBHOOK_SECRET,
  events,
}) {
  if (!secret) throw new Error('PARTNER_FAKE_PENDANT_WEBHOOK_SECRET tanımlı değil');
  const body = JSON.stringify({ events });
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const res = await fetch(`${api}/webhooks/partners/${PARTNER}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-partner-timestamp': String(ts),
      'x-partner-nonce': nonce,
      'x-partner-signature': partnerSignature(secret, ts, nonce, body),
    },
    body,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* boş gövde */
  }
  return { status: res.status, body: json };
}
