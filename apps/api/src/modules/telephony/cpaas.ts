import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * T-050 CPaaS sağlayıcı arayüzü (03 "telephony"). Uygulamalar: TwilioProvider (üretim), FakeProvider (geliştirme ve
 * test; webhook'ları kendisi tetikler). Konferans ve WebRTC istemcisi T-051'de eklenir.
 *
 * Giden arama modeli (tıkla-ara köprüsü): sağlayıcı önce operatörün ucunu (`agent`: masa hattı, T-051'de yazılım
 * telefonu) arar, operatör açınca aranan tarafa bağlanır. Aranan tarafa açar açmaz kayıt anonsu okunur, görüşme
 * iki kanallı kaydedilir. Durum ve kayıt webhook'ları `?call=<bizim arama kimliğimiz>` taşır.
 */
export interface DialRequest {
  callId: string;
  /** Aranan numara (E.164). Log'a yazılmaz. */
  to: string;
  /** Operatör ucu (masa hattı E.164 veya `client:<kimlik>`). */
  agent: string;
  timeoutSec: number;
  urls: WebhookUrls;
}

export interface WebhookUrls {
  /** Aranan bacağın durumu (initiated, ringing, answered, completed …). */
  status: string;
  /** Bağlantı (Dial) sonucu. */
  dial: string;
  /** Operatör bacağının durumu. */
  agent: string;
  recording: string;
  /** Aranan tarafa okunacak kayıt anonsu (TwiML). */
  announce: string;
}

export interface CpaasProvider {
  readonly name: string;
  call(r: DialRequest): Promise<{ providerCallId: string }>;
  hangup(providerCallId: string): Promise<void>;
  fetchRecording(recordingId: string): Promise<Buffer>;
  deleteRecording(recordingId: string): Promise<void>;
  sendSms(to: string, body: string): Promise<{ providerId: string }>;
  /** Metni okuyup kapatan arama (D-08 sesli bildirim). */
  ttsCall(to: string, text: string): Promise<{ providerCallId: string }>;
  /** Webhook imzası (Twilio X-Twilio-Signature şeması). */
  verify(url: string, params: Record<string, string>, signature: string | undefined): boolean;
}

/** Twilio istek imzası: base64(HMAC-SHA1(token, URL + sıralı anahtar+değer)). */
export function cpaasSignature(token: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifySignature(
  token: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const a = Buffer.from(cpaasSignature(token, url, params));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const XML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export const xml = (s: string) => s.replace(/[&<>"']/g, (c) => XML[c]!);

/** Aranan tarafa okunacak anons (TwiML). */
export const sayTwiml = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="tr-TR" voice="Polly.Filiz">${xml(text)}</Say></Response>`;

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
