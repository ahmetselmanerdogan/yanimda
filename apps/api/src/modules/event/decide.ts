import type { EventType, NotifyRequest, Signal } from '@yanimda/contracts';

import { ruleFor, type RulePack } from './rules.loader';

/**
 * D-02 sinyal → karar (T-012). Saf fonksiyon: cihaz ve ülke bilmez; eşikler ve bastırmalar kural paketinden.
 * Kabul testi bu fonksiyonun tablo testidir (test/decide.spec.ts).
 */
export type Notice = Pick<NotifyRequest, 'code' | 'audience'>;

export type Decision =
  | { action: 'create'; type: EventType }
  | { action: 'answer' } //   CANCEL / OK: cihaz sorusuna cevap
  | { action: 'on-body' } //  saat takıldı: WATCH_OFF kapanır
  | { action: 'notify'; notices: Notice[] }
  | { action: 'none'; reason: string };

export interface DecideContext {
  pack: RulePack;
  /** Sinyal anı kişinin gece penceresinde mi (yalnız OFF_BODY için gerekir). */
  night: boolean;
  /** T-070: kişiye özel hareketsizlik eşiği (dk). Kural `learnable` ise paket varsayılanının yerine geçer. */
  inactivityMin?: number | null;
}

/** Pil eşikleri (A-06): saat %20 ve %10'da BATTERY gönderir. */
export const BATTERY_WARN_PCT = 20;
export const BATTERY_CRITICAL_PCT = 10;
/** Kapanmış sayılan pil (BATTERY_DEAD adayı). */
export const BATTERY_DEAD_PCT = 5;
/** HEARTBEAT boşluğu: 15 dk → "bağlantı yok" (cihaz durumu), CONNECTION_LOST kuralı afterHours → olay. */
export const NO_CONNECTION_MIN = 15;

const SIMPLE: Partial<Record<Signal['kind'], EventType>> = {
  SOS: 'SOS',
  FALL: 'FALL',
  CALLBACK_REQUEST: 'CALLBACK',
  TEST: 'TEST',
};

export function decide(s: Pick<Signal, 'kind' | 'value'>, ctx: DecideContext): Decision {
  const create = (type: EventType): Decision => {
    const rule = ruleFor(ctx.pack, type);
    if (!rule) return { action: 'none', reason: `kural yok: ${type}` };
    if (ctx.night && rule.suppressIn?.includes('NIGHT')) return { action: 'none', reason: 'gece penceresi' };
    return { action: 'create', type };
  };

  switch (s.kind) {
    case 'CANCEL':
    case 'OK':
      return { action: 'answer' };
    case 'ON_BODY':
      return { action: 'on-body' };
    case 'OFF_BODY':
      return create('WATCH_OFF');
    case 'INACTIVITY': {
      const threshold = inactivityThreshold(ctx.pack, ctx.inactivityMin);
      // Değer yoksa eşiği cihaz kendisi aşmıştır (A-04); varsa paketin eşiğiyle karşılaştır (T-070: kişiye özel).
      if (typeof s.value === 'number' && threshold !== undefined && s.value < threshold)
        return { action: 'none', reason: 'eşik altı' };
      return create('INACTIVITY');
    }
    case 'BATTERY': {
      if (typeof s.value !== 'number') return { action: 'none', reason: 'pil değeri yok' };
      if (s.value <= BATTERY_CRITICAL_PCT)
        return {
          action: 'notify',
          notices: [
            { code: 'W-BAT-10', audience: 'ELDER' },
            { code: 'F-BAT-10', audience: 'FAMILY' },
          ],
        };
      if (s.value <= BATTERY_WARN_PCT) return { action: 'notify', notices: [{ code: 'W-BAT-20', audience: 'ELDER' }] };
      return { action: 'none', reason: 'pil yeterli' };
    }
    case 'HEARTBEAT':
    case 'HEART_RATE':
    case 'STEPS':
    case 'LOCATION':
      return { action: 'none', reason: 'yalnız kayıt' };
    default: {
      const type = SIMPLE[s.kind];
      return type ? create(type) : { action: 'none', reason: `bilinmeyen sinyal: ${s.kind}` };
    }
  }
}

/**
 * Geçerli hareketsizlik eşiği (dk): kural `learnable` ve kişiye özel değer varsa o (kuralın min–max aralığına
 * kırpılır), yoksa paket varsayılanı. Kural yoksa undefined.
 */
export function inactivityThreshold(pack: RulePack, personal?: number | null): number | undefined {
  const t = ruleFor(pack, 'INACTIVITY')?.thresholdMin;
  if (!t) return undefined;
  if (!t.learnable || personal == null) return t.default;
  return Math.min(t.max ?? personal, Math.max(t.min ?? personal, personal));
}

export type ConnectionState = 'ONLINE' | 'NO_CONNECTION' | 'LOST';

/** Cihaz bağlantı durumu son görülme zamanından (T-014 GET /status bunu kullanır). */
export function connectionState(lastSeenAt: Date | null, now: Date, pack: RulePack): ConnectionState {
  if (!lastSeenAt) return 'LOST';
  const min = (now.getTime() - lastSeenAt.getTime()) / 60_000;
  const lostAfterMin = (ruleFor(pack, 'CONNECTION_LOST')?.afterHours ?? 6) * 60;
  if (min >= lostAfterMin) return 'LOST';
  if (min >= NO_CONNECTION_MIN) return 'NO_CONNECTION';
  return 'ONLINE';
}
