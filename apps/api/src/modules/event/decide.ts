import type { DeviceTier, EventType, NotifyRequest, Signal } from '@yanimda/contracts';

import { batteryOf, coverageOf, pendantOf, ruleFor, type RulePack } from './rules.loader';

/**
 * D-02 sinyal → karar (T-012). Saf fonksiyon: cihaz ve ülke bilmez; eşikler ve bastırmalar kural paketinden.
 * Kabul testi bu fonksiyonun tablo testidir (test/decide.spec.ts).
 */
export type Notice = Pick<NotifyRequest, 'code' | 'audience'>;

/**
 * Yok sayma nedeni (denetime yazılır): CHARGING_FALL şarjdaki cihazın düşmesi (S3.4); TIER_C eğilim sınıfı cihaz olay
 * açamaz; TIER_B_P1 canlı izlem sınıfı cihaz P1 (SOS / düşme) açamaz (S2.1, T-085 OEM).
 */
export type IgnoreReason = 'CHARGING_FALL' | 'TIER_C' | 'TIER_B_P1';

export type Decision =
  /** `note`: CREATED geçişinin notu (KAPSAMA BOŞLUĞU'nda neden kodu, ör. NOT_WORN). */
  | { action: 'create'; type: EventType; note?: string }
  | { action: 'answer' } //   CANCEL / OK: cihaz sorusuna cevap
  | { action: 'on-body' } //  saat takıldı: WATCH_OFF kapanır
  | { action: 'notify'; notices: Notice[] }
  | { action: 'charge-start' } // T-086: şarja takıldı — bekleyen WATCH_OFF kapanır (şarj boşluğu devralır)
  | { action: 'ignore'; reason: IgnoreReason } // S3.4 şarjdaki düşme; S2.1 sınıf kapısı — denetime yazılır
  | { action: 'none'; reason: string };

export interface DecideContext {
  pack: RulePack;
  /** Sinyal anı kişinin gece penceresinde mi (yalnız OFF_BODY için gerekir). */
  night: boolean;
  /** T-070: kişiye özel hareketsizlik eşiği (dk). Kural `learnable` ise paket varsayılanının yerine geçer. */
  inactivityMin?: number | null;
  /** T-086: sinyali gönderen cihaz (sinyal uygulandıktan sonra) şarjda: pil uyarıları susar, "çıkarıldı" açılmaz. */
  charging?: boolean;
  /** T-085 (S3.4): sinyal uygulandıktan sonra korumaya sayılan (takılı) bir A sınıfı cihaz var. */
  alarmWorn?: boolean;
  /** Sinyali gönderen cihaz A sınıfı giyilebilir mi; değilse (yüzük, telefon) çıkarılması olay açmaz. */
  alarmWearable?: boolean;
  /**
   * T-085 OEM (S2.1): sinyali gönderen cihazın sınıfı. Yalnız A sınıfı P1 açar; B sınıfı SOS / düşme (P1) açamaz (P2/P3
   * yalnız kurallarla); C sınıfı hiçbir olay açmaz. Verilmezse A (eski kayıtlar).
   */
  tier?: DeviceTier;
  /** S4.9: katalogdaki pil ömrü uzun (12 ay kolye): yaşlıya pil bildirimi gitmez, bakım iş emri açılır. */
  longLifeBattery?: boolean;
}

const SIMPLE: Partial<Record<Signal['kind'], EventType>> = {
  SOS: 'SOS',
  CALLBACK_REQUEST: 'CALLBACK',
  TEST: 'TEST',
};

/**
 * Pil eşikleri kural paketinde (`battery`, T-086): warnPct → W-BAT-20, criticalPct → W-BAT-10 + F-BAT-10. Kod adları
 * katalogdaki tarihsel adlardır. Şarjdaki cihazın pil uyarısı gönderilmez.
 */
export function decide(s: Pick<Signal, 'kind' | 'value' | 'device' | 'payload'>, ctx: DecideContext): Decision {
  return tierGate(decideKind(s, ctx), ctx);
}

/**
 * S2.1 sınıf kapısı (T-085 OEM; adaptör profilinin yanında olay motorunda ikinci kez): C sınıfı olay açmaz, B sınıfı
 * önceliği 1 olan olayı (SOS, düşme) açmaz. Olay motoru cihaz bilmez: sınıf sinyalin `source` alanından gelir.
 */
export function tierGate(d: Decision, ctx: Pick<DecideContext, 'pack' | 'tier'>): Decision {
  if (d.action !== 'create' || !ctx.tier || ctx.tier === 'A') return d;
  if (ctx.tier === 'C') return { action: 'ignore', reason: 'TIER_C' };
  if (ruleFor(ctx.pack, d.type)?.priority === 1) return { action: 'ignore', reason: 'TIER_B_P1' };
  return d;
}

function decideKind(s: Pick<Signal, 'kind' | 'value' | 'device' | 'payload'>, ctx: DecideContext): Decision {
  const create = (type: EventType, note?: string): Decision => {
    const rule = ruleFor(ctx.pack, type);
    if (!rule) return { action: 'none', reason: `kural yok: ${type}` };
    if (ctx.night && rule.suppressIn?.includes('NIGHT')) return { action: 'none', reason: 'gece penceresi' };
    return note ? { action: 'create', type, note } : { action: 'create', type };
  };

  switch (s.kind) {
    case 'CANCEL':
    case 'OK':
      return { action: 'answer' };
    case 'ON_BODY':
      return { action: 'on-body' };
    case 'OFF_BODY':
      // T-085 OEM (S4.9): üreticinin "N gündür takılmadı" bildirimi (value = gün). Eşik ve üstü KAPSAMA BOŞLUĞU P3
      // (neden NOT_WORN), yaşlıya hatırlatma yok; başka bir A sınıfı cihaz takılıysa açılmaz.
      if (typeof s.value === 'number') {
        if (s.value < pendantOf(ctx.pack).notWornMinDays)
          return { action: 'none', reason: 'takılmadı bildirimi eşik altı' };
        if (ctx.alarmWorn) return { action: 'none', reason: 'başka alarm cihazı takılı' };
        return create('COVERAGE_GAP', 'NOT_WORN');
      }
      // S3.4: "saat çıkarıldı" yalnız hiçbir A sınıfı cihaz takılı değilken; şarja takılan cihaz şarj boşluğuna girer.
      if (ctx.charging || s.device?.charging === true) return { action: 'none', reason: 'şarjda' };
      if (ctx.alarmWearable === false) return { action: 'none', reason: 'alarm cihazı değil' };
      if (ctx.alarmWorn) return { action: 'none', reason: 'başka alarm cihazı takılı' };
      return create('WATCH_OFF');
    case 'FALL':
      if (s.device?.charging === true) return { action: 'ignore', reason: 'CHARGING_FALL' };
      return create('FALL');
    case 'CHARGE_START':
      return { action: 'charge-start' };
    case 'CHARGE_END':
      return { action: 'none', reason: 'yalnız kayıt' };
    case 'INACTIVITY': {
      const threshold = inactivityThreshold(ctx.pack, ctx.inactivityMin);
      // Değer yoksa eşiği cihaz kendisi aşmıştır (A-04); varsa paketin eşiğiyle karşılaştır (T-070: kişiye özel).
      if (typeof s.value === 'number' && threshold !== undefined && s.value < threshold)
        return { action: 'none', reason: 'eşik altı' };
      return create('INACTIVITY');
    }
    case 'BATTERY': {
      if (typeof s.value !== 'number') return { action: 'none', reason: 'pil değeri yok' };
      if (ctx.charging || s.device?.charging === true) return { action: 'none', reason: 'şarjda' };
      // S4.9: 12 ay pilli kolyede yaşlı hiç rahatsız edilmez; pil bakım iş emri (PendantMaintenanceService) açılır.
      if (ctx.longLifeBattery) return { action: 'none', reason: 'uzun ömürlü pil: bakım iş emri' };
      const b = batteryOf(ctx.pack);
      if (s.value <= b.criticalPct)
        return {
          action: 'notify',
          notices: [
            { code: 'W-BAT-10', audience: 'ELDER' },
            { code: 'F-BAT-10', audience: 'FAMILY' },
          ],
        };
      if (s.value <= b.warnPct) return { action: 'notify', notices: [{ code: 'W-BAT-20', audience: 'ELDER' }] };
      return { action: 'none', reason: 'pil yeterli' };
    }
    case 'TEST':
      // T-089: operatörün TEST komutuna cihazın cevabı (payload.trigger OPERATOR) yeni test olayı açmaz; yalnız kayıt
      // (cihaz config'i lastTestAt). Kişinin kendi başlattığı test (düğme) TEST olayıdır.
      if (s.payload?.trigger === 'OPERATOR') return { action: 'none', reason: 'operatör testi' };
      return create('TEST');
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

/**
 * Cihaz bağlantı durumu son görülme zamanından (T-014 GET /status bunu kullanır). "Bağlantı yok" eşiği A sınıfı
 * çevrimiçi süresi (kural paketi `coverage.onlineMin.A`), "uzun süredir yok" CONNECTION_LOST.afterHours.
 */
export function connectionState(lastSeenAt: Date | null, now: Date, pack: RulePack): ConnectionState {
  if (!lastSeenAt) return 'LOST';
  const min = (now.getTime() - lastSeenAt.getTime()) / 60_000;
  const lostAfterMin = (ruleFor(pack, 'CONNECTION_LOST')?.afterHours ?? 6) * 60;
  if (min >= lostAfterMin) return 'LOST';
  if (min >= coverageOf(pack).onlineMin.A) return 'NO_CONNECTION';
  return 'ONLINE';
}
