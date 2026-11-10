import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * T-050 CPaaS sağlayıcı arayüzü (03 "telephony"). Uygulamalar: TwilioProvider (üretim), FakeProvider (geliştirme ve
 * test; webhook'ları kendisi tetikler).
 *
 * Giden arama modeli (tıkla-ara köprüsü): sağlayıcı önce operatörün ucunu (`agent`: yazılım telefonu
 * `client:<operatör>` veya masa hattı) arar, operatör açınca aranan tarafa bağlanır. Aranan tarafa açar açmaz kayıt anonsu okunur, görüşme
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
  /** T-051: konferansa eklenen yakının bacağı. */
  party: string;
}

/**
 * T-051 konferans işlemleri (Twilio `<Conference>`; oda adı `yanimda-<arama>`).
 *  - move: aranan bacağı odaya taşı (köprü biter; operatörün Dial'ı `dial` webhook'unda odaya katılır).
 *  - add: yakını ara; açınca kayıt anonsu + oda.
 *  - hold: aranan bacağı beklet / devam.
 */
export type ConferenceOp =
  | { kind: 'move'; room: string; legCallId: string; urls: WebhookUrls }
  | { kind: 'add'; room: string; /** Log'a yazılmaz. */ to: string; announce: string; urls: WebhookUrls }
  | { kind: 'hold'; room: string; legCallId: string; hold: boolean };

/**
 * T-072 (D-12) otomatik sesli ön eleme araması: kişiye doğrudan (operatörsüz) arama; açınca soru okunur, DTMF veya
 * konuşma (tr-TR) beklenir. Sonuç `gather`, arama durumu `status` webhook'una gelir (`?s=<ön eleme kimliği>`).
 */
export interface ScreenRequest {
  screeningId: string;
  /** Aranan numara (E.164). Log'a yazılmaz. */
  to: string;
  /** Okunacak soru (katalog, voice kanalı). */
  ask: string;
  /** Konuşma tanıma ipuçları (kabul/yardım terimleri). */
  hints: string[];
  /** Beklenen tuş sayısı. */
  digits: number;
  ringTimeoutSec: number;
  urls: { gather: string; status: string };
}

export interface CpaasProvider {
  readonly name: string;
  call(r: DialRequest): Promise<{ providerCallId: string }>;
  hangup(providerCallId: string): Promise<void>;
  fetchRecording(recordingId: string): Promise<Buffer>;
  deleteRecording(recordingId: string): Promise<void>;
  /** statusCallback: teslim raporu webhook'u (T-053). */
  sendSms(to: string, body: string, statusCallback?: string): Promise<{ providerId: string }>;
  /** Metni okuyup kapatan arama (D-08 sesli bildirim). */
  ttsCall(to: string, text: string): Promise<{ providerCallId: string }>;
  /** T-072: soru sorup DTMF/konuşma bekleyen arama (otomatik sesli ön eleme). */
  screenCall(r: ScreenRequest): Promise<{ providerCallId: string }>;
  /** T-051: konferansa taşı, yakın ekle, beklet. `add` yeni bacağın kimliğini döner. */
  conference(op: ConferenceOp): Promise<{ providerCallId?: string }>;
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

/**
 * Odaya katılma TwiML'i. Operatör `endOnExit` ile katılır (çıkınca oda kapanır); `record` verilirse oda kaydı
 * başından alınır ve kayıt webhook'una gelir. Bekleme müziği yok (waitUrl boş).
 */
export function conferenceTwiml(room: string, o: { endOnExit: boolean; recordingUrl?: string; say?: string }): string {
  const rec = o.recordingUrl
    ? ` record="record-from-start" recordingStatusCallback="${xml(o.recordingUrl)}" recordingStatusCallbackEvent="completed"`
    : '';
  const say = o.say ? `<Say language="tr-TR" voice="Polly.Filiz">${xml(o.say)}</Say>` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Dial><Conference startConferenceOnEnter="true"` +
    ` endConferenceOnExit="${o.endOnExit}" beep="false" waitUrl=""${rec}>${xml(room)}</Conference></Dial></Response>`
  );
}

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/**
 * T-072 ön eleme TwiML'i: soru `<Gather input="dtmf speech" language="tr-TR">` içinde okunur; cevap yoksa bir kez
 * tekrarlanır, ikinci de boşsa `actionOnEmptyResult` ile action yine çağrılır (cevapsız). Konuşma tanıma Twilio'nun
 * (Google) tr-TR modeli; ipuçları kabul/yardım terimleri.
 */
export function screenTwiml(o: { ask: string; gatherUrl: string; hints: string[]; digits: number }): string {
  const say = `<Say language="tr-TR" voice="Polly.Filiz">${xml(o.ask)}</Say>`;
  const gather = (last: boolean) =>
    `<Gather input="dtmf speech" language="tr-TR" numDigits="${o.digits}" timeout="6" speechTimeout="auto"` +
    ` hints="${xml(o.hints.join(', '))}" action="${xml(o.gatherUrl)}" method="POST"` +
    `${last ? ' actionOnEmptyResult="true"' : ''}>${say}</Gather>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${gather(false)}${gather(true)}</Response>`;
}

/** Ön eleme sonucunda okunup kapatılan TwiML. */
export const sayAndHangupTwiml = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="tr-TR" voice="Polly.Filiz">${xml(text)}</Say><Hangup/></Response>`;
