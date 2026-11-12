import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { ConnectionPath, DeviceCategory, DeviceTier, Signal, SignalKind } from '@yanimda/contracts';

import type { DeviceAdapter, DeviceCapabilities } from '../device/device.types';
import type { PushOutcome } from '../device/push.port';

/**
 * T-085 OEM ortak adaptörü sözleşmesi (docs/07 S2.5). Bir ortak (hücresel kolye merkezi, ev üniteli radyo kolye
 * merkezi, üretici bulutu) şunları sağlar:
 *  - Model profili: yetenekler, sınıf (A/B/C), bağlantı yolu, gecikme hedefi (p95) ve kalite sınıfı.
 *  - Sinyal dönüştürme: üretici olayı → kanonik sinyal; idempotencyKey üretici olay kimliğinden türetilir
 *    (`partnerIdempotencyKey`), aynı olay iki kez teslim edilse de bir kez yazılır.
 *  - Cihaz komutları (soru, çaldır, ara, konum, test) — yalnız profilde varsa (yetenek kapısı).
 *  - Canlılık (son görülme = sinyal anı; gecikme p95/p99 PartnerHealthService'te) ve takılı kanıtı (doğruluk 0–1).
 * Profil dışı sinyal yalnız o sinyal olarak reddedilir ve denetime yazılır. Sınıf kesindir (S2.1): C sınıfı profil olay
 * açan sinyal içeremez, B sınıfı SOS/düşme/iptal içeremez (`assertProfileClass`); olay motoru da aynı kuralı sınıfa göre
 * ayrıca uygular (decide.ts `tierGate`).
 */

export type PartnerCommandType = 'PROMPT' | 'RING' | 'CALL' | 'LOCATE' | 'TEST';
export type LatencyClass = 'INSTANT' | 'NEAR' | 'BATCH' | 'DAILY';
export type QualityClass = 'Q1' | 'Q2' | 'Q3';

export interface PartnerModelProfile {
  /** device.device_model kimliği (katalog satırı migration'la gelir). */
  modelId: string;
  category: DeviceCategory;
  tier: DeviceTier;
  connectionPath: ConnectionPath;
  /** Bu modelin gönderebileceği kanonik sinyaller; dışındakiler reddedilir. */
  signals: SignalKind[];
  voice: boolean;
  location: boolean;
  fallDetection: boolean;
  /** Takılı kanıtı veriyor (doğruluk 0–1). */
  wornEvidence: boolean;
  /** Sözleşmedeki uçtan uca gecikme hedefi p95 (sn; S2.1: ortak merkez ≤15 sn). */
  latencyTargetP95Sec: number;
  latencyClass: LatencyClass;
  /** Değer ölçen modellerde kalite sınıfı (S1.4); alarm cihazında null. */
  quality: QualityClass | null;
  /** Desteklenen cihaz komutları. */
  commands: PartnerCommandType[];
}

export type PartnerCommand =
  | { type: 'PROMPT'; eventId: string; tts: string; windowSec: number }
  | { type: 'RING'; eventId: string }
  | { type: 'CALL'; eventId: string }
  | { type: 'LOCATE'; eventId: string }
  | { type: 'TEST' };

/** Ortak merkezine komut gönderen kapı (gerçek ortakta HTTP; sahte ortakta bellek). Üretici kimliği kapı çözer. */
export interface PartnerGateway {
  send(partner: string, deviceId: string, cmd: PartnerCommand): Promise<PushOutcome | void>;
}

export class RecordingPartnerGateway implements PartnerGateway {
  readonly sent: { partner: string; deviceId: string; cmd: PartnerCommand }[] = [];
  async send(partner: string, deviceId: string, cmd: PartnerCommand): Promise<void> {
    this.sent.push({ partner, deviceId, cmd });
    if (this.sent.length > 1000) this.sent.shift();
  }
}

/** Üretici olayından türetilen kanonik sinyalin cihaz/kişi dışındaki alanları. */
export type SignalDraft = Pick<Signal, 'kind'> & Partial<Pick<Signal, 'value' | 'location' | 'device' | 'payload'>>;

export type ParsedPartnerEvent =
  | { ok: true; vendorEventId: string; vendorDeviceId: string; occurredAt: string; draft: SignalDraft }
  | { ok: false; vendorEventId: string | null; reason: 'EVENT_INVALID' };

export interface PartnerAdapter extends DeviceAdapter {
  /** Ortak kodu = cihaz türü (device.device.kind). */
  readonly partner: string;
  /** Ortağın veri bölgesi (S9.3): TR dışıysa bağlantı açık rıza / aktarım dayanağı ister. */
  readonly dataRegion: string;
  profiles(): readonly PartnerModelProfile[];
  profile(modelId: string | null | undefined): PartnerModelProfile | undefined;
  /** Webhook gövdesi → üretici olayları (her biri ayrı ayrı geçerli / geçersiz). */
  parse(body: unknown): ParsedPartnerEvent[];
  /**
   * Yetenek kapılı cihaz komutu (soru, çaldır, ara, konum, test): modelin profilinde yoksa 'unsupported' (ağa çıkmaz).
   * CALL: iki yönlü sesli görüşmeyi ortak merkezi kurar (kolye kendi hattından arar).
   */
  sendCommand(deviceId: string, modelId: string | null | undefined, cmd: PartnerCommand): Promise<PushOutcome>;
  capabilitiesFor(modelId: string | null | undefined): DeviceCapabilities;
}

export const isPartnerAdapter = (a: DeviceAdapter): a is PartnerAdapter =>
  typeof (a as Partial<PartnerAdapter>).parse === 'function' &&
  typeof (a as Partial<PartnerAdapter>).partner === 'string';

/** Olay açabilen / iptal eden sinyaller: C sınıfı profil bunları içeremez (S2.1, S3.5, S3.6). */
const EVENT_SIGNALS: ReadonlySet<SignalKind> = new Set([
  'SOS',
  'FALL',
  'CANCEL',
  'OK',
  'INACTIVITY',
  'CALLBACK_REQUEST',
  'TEST',
  'LOCATION',
]);
/** B sınıfı (canlı izlem) SOS / düşme açamaz ve alarmı iptal edemez; P2/P3 yalnız kurallarla (Bölüm 6). */
const B_FORBIDDEN: ReadonlySet<SignalKind> = new Set(['SOS', 'FALL', 'CANCEL', 'OK']);

export class InvalidPartnerProfileError extends Error {}

/** Profil sınıfıyla tutarlı mı (adaptör kaydında denetlenir; tutarsız profil uygulamayı başlatmaz). */
export function assertProfileClass(p: PartnerModelProfile): void {
  const bad = (why: string) => new InvalidPartnerProfileError(`${p.modelId}: ${why}`);
  if (p.tier === 'C') {
    const x = p.signals.find((k) => EVENT_SIGNALS.has(k));
    if (x) throw bad(`C sınıfı ${x} gönderemez`);
    if (p.fallDetection || p.voice) throw bad('C sınıfı düşme / ses yeteneği taşıyamaz');
  }
  if (p.tier === 'B') {
    const x = p.signals.find((k) => B_FORBIDDEN.has(k));
    if (x) throw bad(`B sınıfı ${x} gönderemez`);
    if (p.fallDetection) throw bad('B sınıfı düşme yeteneği taşıyamaz');
  }
  if (p.fallDetection !== p.signals.includes('FALL')) throw bad('düşme yeteneği ile FALL sinyali tutarsız');
}

/** Profil → cihaz yetenekleri (DeviceService komut kapısı ve sinyalin source alanı). */
export function capabilitiesOf(p: PartnerModelProfile): DeviceCapabilities {
  return {
    role: 'WATCH',
    category: p.category,
    tier: p.tier,
    voice: p.voice,
    location: p.location,
    signals: [...p.signals],
    fallDetection: p.fallDetection,
    offBodyDetection: p.wornEvidence,
    heartRate: p.signals.includes('HEART_RATE'),
    devicePrompt: p.commands.includes('PROMPT'),
    tts: false,
    ring: p.commands.includes('RING'),
  };
}

/** S2.5: üretici olay kimliğinden türetilen idempotencyKey (ortaklar arası çakışmaz, şemadaki biçime uyar). */
export function partnerIdempotencyKey(partner: string, vendorEventId: string): string {
  return `oem:${partner}:${createHash('sha256').update(vendorEventId, 'utf8').digest('hex').slice(0, 40)}`;
}

/** Takılı kanıtı (0–1): ≥ WORN_MIN takılı, ≤ NOT_WORN_MAX takılı değil, arası belirsiz (durum değişmez). */
export const WORN_MIN = 0.8;
export const NOT_WORN_MAX = 0.2;
export function wornOf(confidence: number): boolean | undefined {
  if (confidence >= WORN_MIN) return true;
  if (confidence <= NOT_WORN_MAX) return false;
  return undefined;
}

// ---- İmzalı webhook (S2.6 "İmzalı webhook, tekrar koruması, idempotency") ----

export const SIGNATURE_HEADER = 'x-partner-signature';
export const TIMESTAMP_HEADER = 'x-partner-timestamp';
export const NONCE_HEADER = 'x-partner-nonce';
/** İmza zaman damgası toleransı (sn): daha eski / ileri tarihli teslim reddedilir. */
export const SIGNATURE_TOLERANCE_SEC = 300;

/** `v1=<hex>` = HMAC-SHA256(sır, "<unix sn>.<nonce>.<ham gövde>"). */
export function partnerSignature(secret: string, ts: number, nonce: string, rawBody: Buffer | string): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${ts}.${nonce}.`);
  mac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
  return `v1=${mac.digest('hex')}`;
}

export function signatureValid(
  secret: string,
  ts: number,
  nonce: string,
  rawBody: Buffer,
  given: string | undefined,
): boolean {
  if (!given) return false;
  const a = Buffer.from(partnerSignature(secret, ts, nonce, rawBody));
  return given.split(',').some((g) => {
    const b = Buffer.from(g.trim());
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
