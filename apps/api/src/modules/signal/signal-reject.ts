/**
 * Sinyal başına ret (D-01): partide bir sinyal reddedilince diğerleri yine yazılır; reddedilenler 202 yanıtında
 * `rejected` listesinde döner. Cihaz yalnız burada adı geçen sinyalleri kalıcı hata sayıp atar (SOS ret yüzünden
 * kaybolmaz). `reason` sabit koddur (istemci kodu kendi kataloğuna eşler); PII ve serbest metin içermez.
 */
export const SIGNAL_REJECT_REASONS = [
  /** Şemaya uymuyor (alan eksik/biçim hatalı, istemci `source` gönderdi …). */
  'SCHEMA_INVALID',
  /** Cihaz türü bu sinyali gönderemez (ör. telefondan OFF_BODY) veya kayıtsız cihaz (simülatör kapalı). */
  'UNSUPPORTED_SIGNAL',
  /** Sinyal token'ın kişisinden başka bir kişi adına. */
  'PERSON_MISMATCH',
  /** Sinyal token'ın cihazından başka bir cihaz adına ve token köprü yapamaz (telefon değil / kimlik biçimi). */
  'DEVICE_MISMATCH',
  /** Telefon köprüsü: cihaz bu kişinin etkin saati değil (iptal edilmiş, kayıtsız, başka kişiye geçmiş). */
  'DEVICE_NOT_BRIDGED',
] as const;

export type SignalRejectReason = (typeof SIGNAL_REJECT_REASONS)[number];

/** Yetki retleri: partide kabul edilebilir hiçbir sinyal yoksa ve bunlardan biri varsa yanıt 403 (yoksa 400). */
export const AUTH_REJECT_REASONS: ReadonlySet<SignalRejectReason> = new Set([
  'PERSON_MISMATCH',
  'DEVICE_MISMATCH',
  'DEVICE_NOT_BRIDGED',
]);

export interface RejectedSignal {
  /** Partideki sıra (0'dan). */
  index: number;
  /** Sinyalin kendi anahtarı (geçerli biçimdeyse); cihaz tamponundaki kaydı bununla bulur. */
  idempotencyKey?: string;
  reason: SignalRejectReason;
}

const KEY = /^[\x21-\x7e]{8,200}$/;

export function rejectedEntry(index: number, raw: unknown, reason: SignalRejectReason): RejectedSignal {
  const k = (raw as { idempotencyKey?: unknown } | null)?.idempotencyKey;
  return typeof k === 'string' && KEY.test(k) ? { index, idempotencyKey: k, reason } : { index, reason };
}

/** ProblemFilter: hata gövdesine yalnız biçimi doğrulanmış `rejected` listesi geçer. */
export function sanitizeRejected(v: unknown): RejectedSignal[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RejectedSignal[] = [];
  for (const r of v as Partial<RejectedSignal>[]) {
    if (!r || !Number.isInteger(r.index) || !SIGNAL_REJECT_REASONS.includes(r.reason as SignalRejectReason)) continue;
    out.push(rejectedEntry(r.index!, r, r.reason!));
  }
  return out;
}
