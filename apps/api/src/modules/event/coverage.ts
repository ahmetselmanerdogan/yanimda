import type {
  CoverageCapabilities,
  CoverageGapReason,
  CoverageLevel,
  CoverageReason,
  DeviceCategory,
  DeviceTier,
  ProtectionState,
  Signal,
  SignalSource,
  WelfareReason,
} from '@yanimda/contracts';

import type { ChargingParams, CoverageNoneParams, CoverageParams } from './rules.loader';

/**
 * T-085 / T-086 kapsama durumu (docs/07 S1–S4). Saf fonksiyonlar: cihaz olguları + an + kişinin gece penceresi →
 * seviye, yetenekler, nedenler; şarj boşluğu ve "kapsama yok" zamanlayıcılarının adımları. Olay motoru cihaz modeli
 * bilmez: kategori, sınıf ve yetenekler sinyalin `source` alanından gelir (cihaz adaptörü + katalog).
 *
 * Seviye (S3.1):
 *   FULL        takılı, çevrimiçi, şarjda olmayan A sınıfı cihaz(lar) SOS ve düşmeyi karşılıyor; ses en az telefondan
 *   BASIC       takılı SOS düğmesi ve ses var, düşme yok
 *   PHONE_ONLY  yalnız telefondan SOS
 *   NIGHT       gece penceresi ve seviye FULL'un altında
 *   NONE        hiçbir SOS yolu yok
 * Bir yetenek ancak cihaz çevrimiçi (A 15 dk, B 30 dk; köprülü cihaz köprüsü de çevrimiçiyse), şarjda değil, pili
 * ölü değil ve (vücut yetenekleri için) takılıysa sayılır (S1.4). Telefon köprüsüyle gelen her sinyal telefonun da
 * canlı olduğunu gösterir; telefon düşünce köprülü cihazlar da düşer (S4.8).
 */

export interface DeviceFact {
  id: string;
  /** Cihaz türü (adaptör); kayıtsız cihazda SIMULATOR. */
  kind?: string;
  category: DeviceCategory;
  tier: DeviceTier;
  caps: CoverageCapabilities;
  batteryLifeH: number | null;
  seenAt: string | null;
  onBody: boolean | null;
  charging: boolean;
  chargingSince: string | null;
  /** Şarjdan çıktı ama henüz takılmadı (takma hatırlatmaları, S4.4). */
  chargeEndedAt: string | null;
  batteryPct: number | null;
  /** Son sinyal telefon köprüsünden (BLE) geldi: telefon düşerse bu cihaz da düşer. */
  bridged: boolean;
  /** T-085 OEM (S4.9): üretici hattın düştüğünü bildirdi (son bilgi); cihaz çevrimdışı sayılır. */
  lineDown?: boolean;
  /** T-085 OEM (S4.9): ev ünitesinin elektriği kesildi (yedek pilde); cihaz çalışır, kapsama nedeni olur. */
  powerLoss?: boolean;
  /** T-085 OEM: ev ünitesi üzerinden bağlı (radyo kolye); ev ünitesinin hattı düşerse bu cihaz da düşer. */
  viaHomeUnit?: boolean;
}

export interface Facts {
  devices: Record<string, DeviceFact>;
  /** Telefon köprüsünün son görüldüğü an (köprülü cihazın sinyali telefonun canlı olduğunu gösterir). */
  bridgeSeenAt: string | null;
}

export const emptyFacts = (): Facts => ({ devices: {}, bridgeSeenAt: null });

const BODY: ReadonlySet<DeviceCategory> = new Set(['WATCH', 'PENDANT', 'RING', 'EARBUD', 'EARRING']);
export const isWearable = (d: Pick<DeviceFact, 'category'>) => BODY.has(d.category);
/** Alarm sınıfı (A) giyilebilir: korumaya sayılan, SOS/düşme açabilen cihaz. Telefon ayrı sayılır. */
export const isAlarmWearable = (d: Pick<DeviceFact, 'category' | 'tier'>) => d.tier === 'A' && isWearable(d);

const caps = (sos: boolean, fall: boolean, voice: boolean, location: boolean): CoverageCapabilities => ({
  sos,
  fall,
  voice,
  location,
});
/** Kataloğu olmayan (eski / kayıtsız) cihazlar için kategori varsayılanları (S2.1). */
export const DEFAULT_CAPS: Record<DeviceCategory, CoverageCapabilities> = {
  WATCH: caps(true, true, true, true),
  PHONE: caps(true, false, true, true),
  PENDANT: caps(true, true, true, true),
  RING: caps(false, false, false, false),
  EARBUD: caps(false, false, false, false),
  EARRING: caps(false, false, false, false),
  HOME_UNIT: caps(false, false, true, false),
  CLOUD: caps(false, false, false, false),
};
export const DEFAULT_TIER: Record<DeviceCategory, DeviceTier> = {
  WATCH: 'A',
  PHONE: 'A',
  PENDANT: 'A',
  RING: 'C',
  EARBUD: 'B',
  EARRING: 'C',
  HOME_UNIT: 'A',
  CLOUD: 'C',
};

export function profileOf(
  source?: SignalSource,
): Pick<DeviceFact, 'kind' | 'category' | 'tier' | 'caps' | 'batteryLifeH' | 'viaHomeUnit'> {
  const category: DeviceCategory = source?.category ?? (source?.role === 'PHONE' ? 'PHONE' : 'WATCH');
  return {
    kind: source?.kind ?? 'SIMULATOR',
    category,
    tier: source?.tier ?? DEFAULT_TIER[category],
    caps: source?.caps ?? DEFAULT_CAPS[category],
    batteryLifeH: source?.batteryLifeH ?? null,
    ...(source?.connectionPath === 'HOME_UNIT' ? { viaHomeUnit: true } : {}),
  };
}

const later = (a: string | null, b: string) => (a && a > b ? a : b);

/**
 * Sinyali olgulara uygular (girişi değiştirmez). Tampondan geç gelen eski sinyal cihazın durumunu (takılı, şarj, pil)
 * değiştirmez; yalnız köprünün görüldüğünü işaretleyebilir.
 */
export function applySignal(f: Facts, s: Signal, at: Date): Facts {
  const iso = at.toISOString();
  const prof = profileOf(s.source);
  const prev = f.devices[s.deviceId];
  const d: DeviceFact = prev
    ? { ...prev, ...prof }
    : {
        id: s.deviceId,
        ...prof,
        seenAt: null,
        onBody: null,
        charging: false,
        chargingSince: null,
        chargeEndedAt: null,
        batteryPct: null,
        bridged: false,
      };
  const out: Facts = { devices: { ...f.devices, [s.deviceId]: d }, bridgeSeenAt: f.bridgeSeenAt };
  const viaPhone = s.device?.connectivity === 'BLE' && d.category !== 'PHONE';
  if (viaPhone) out.bridgeSeenAt = later(f.bridgeSeenAt, iso); // köprülü sinyal: telefon da canlı
  if (d.seenAt && iso < d.seenAt) return out;

  d.seenAt = iso;
  if (s.device?.connectivity) d.bridged = viaPhone;
  const battery =
    s.device?.batteryPct ?? (s.kind === 'BATTERY' && typeof s.value === 'number' ? Math.round(s.value) : undefined);
  if (battery !== undefined) d.batteryPct = battery;
  // T-085 OEM (S4.9): üreticinin bildirdiği hat ve ev ünitesi elektriği (son bilgi geçerli).
  if (typeof s.device?.lineOk === 'boolean') d.lineDown = !s.device.lineOk;
  if (typeof s.device?.mainsPower === 'boolean') d.powerLoss = !s.device.mainsPower;

  const charging = s.kind === 'CHARGE_START' ? true : s.kind === 'CHARGE_END' ? false : s.device?.charging;
  if (charging === true && !d.charging) {
    d.charging = true;
    d.chargingSince = iso;
    d.chargeEndedAt = null;
    d.onBody = false; // şarjdaki cihaz takılı değildir
  } else if (charging === false && d.charging) {
    d.charging = false;
    d.chargingSince = null;
    d.chargeEndedAt = isWearable(d) ? iso : null;
  }

  const onBody = s.kind === 'ON_BODY' ? true : s.kind === 'OFF_BODY' ? false : s.device?.onWrist;
  if (onBody === true) {
    // Takıldıysa şarjdan çıkmıştır (şarj bitti sinyali kaybolmuş olabilir).
    d.charging = false;
    d.chargingSince = null;
    d.chargeEndedAt = null;
    d.onBody = true;
  } else if (onBody === false) d.onBody = false;
  return out;
}

export interface CoverageCtx {
  params: CoverageParams;
  /** Ölü pil eşiği (%): bu ve altı yetenek sayılmaz. */
  deadPct: number;
  /** An gece penceresinde mi. */
  night: boolean;
  /** S4.10 "hastanede / seyahatte" modu açık: nedenlere ON_HOLD eklenir (seviye değişmez). */
  hold?: boolean;
  /** S4.7 YERİNDE KONTROL: takılı cihaz bu pil yüzdesinin üzerindeyken sustuysa "birden sustu" (varsayılan 20). */
  droppedPct?: number;
  /** T-085 OEM (S2.7): gecikmesi bozulan ortakların cihaz türleri; bu türdeki cihazlar "zayıf" (PARTNER_LATENCY). */
  weakKinds?: ReadonlySet<string>;
}

const minutesSince = (iso: string | null, now: Date) =>
  iso ? (now.getTime() - Date.parse(iso)) / 60_000 : Number.POSITIVE_INFINITY;

/** Telefon çevrimiçi: kendi sinyali veya köprülü bir cihazın sinyali A sınıfı süre içinde. */
export function phoneOnline(f: Facts, now: Date, p: CoverageParams): boolean {
  if (minutesSince(f.bridgeSeenAt, now) < p.onlineMin.A) return true;
  return Object.values(f.devices).some((d) => d.category === 'PHONE' && minutesSince(d.seenAt, now) < p.onlineMin.A);
}

/** T-085 OEM: kişinin ev ünitelerinden birinin hattı düştü (ona bağlı radyo kolyeler de düşer). */
const homeUnitLineDown = (f: Facts) =>
  Object.values(f.devices).some((x) => x.category === 'HOME_UNIT' && x.lineDown === true);

/**
 * Cihaz çevrimiçi (S3.2): sınıf süresi içinde görüldü; köprülüyse köprü de çevrimiçi (S4.8). C sınıfı hiç sayılmaz.
 * T-085 OEM: üreticinin bildirdiği hat kaybında cihaz, ev ünitesinin hattı düştüyse ona bağlı kolye de çevrimdışı.
 */
export function deviceOnline(d: DeviceFact, f: Facts, now: Date, p: CoverageParams): boolean {
  if (d.tier === 'C') return false;
  if (d.lineDown === true) return false;
  if (d.viaHomeUnit && d.category !== 'HOME_UNIT' && homeUnitLineDown(f)) return false;
  const limit = d.tier === 'B' ? p.onlineMin.B : p.onlineMin.A;
  if (!(minutesSince(d.seenAt, now) < limit)) return false;
  if (d.bridged && d.category !== 'PHONE' && !phoneOnline(f, now, p)) return false;
  return true;
}

export interface CoverageResult {
  level: CoverageLevel;
  /** Gece penceresi uygulanmadan önceki seviye. */
  rawLevel: Exclude<CoverageLevel, 'NIGHT'>;
  reasons: CoverageReason[];
  capabilities: CoverageCapabilities;
  /** Şu an korumaya sayılan (takılı, çevrimiçi, şarjda değil, pil var) A sınıfı giyilebilirler. */
  worn: string[];
  phoneUsable: boolean;
  /** A sınıfı giyilebilirlerden şarjda olanlar. */
  charging: string[];
  /** Şarjdan çıkmış, henüz takılmamış A sınıfı giyilebilirler. */
  pendingWear: string[];
  /** Pili bitmiş (≤ ölü eşiği) ve susmuş A sınıfı giyilebilirler. */
  dead: string[];
  /** Hiçbir A sınıfı cihaz takılı değil ve en az biri bilerek çıkarılmış (şarj dışı): "saat çıkarıldı". */
  offBody: boolean;
  /** S4.7: son bilinen durumu takılı, şarjda değil, pili droppedPct'nin üzerinde olan ama susmuş A sınıfı cihazlar. */
  dropped: string[];
  /** Telefon (köprü dahil) veya herhangi bir cihaz çevrimiçi. false: tüm cihazlar sessiz (S4.7 6 sa). */
  anyOnline: boolean;
}

export function computeCoverage(f: Facts, now: Date, ctx: CoverageCtx): CoverageResult {
  const p = ctx.params;
  const devices = Object.values(f.devices);
  const alive = (d: DeviceFact) => d.batteryPct === null || d.batteryPct > ctx.deadPct;
  const online = (d: DeviceFact) => deviceOnline(d, f, now, p);
  const alarm = devices.filter(isAlarmWearable);
  const worn = alarm.filter((d) => online(d) && !d.charging && alive(d) && d.onBody === true);
  const phones = devices.filter((d) => d.category === 'PHONE');
  const anyPhoneFact = phones.length > 0;
  // Köprüyle görülen ama kendi kaydı olmayan telefon (eski istemciler / simülatör) SOS'u karşılar sayılır.
  const phoneUsable = anyPhoneFact
    ? phones.some((d) => online(d) && alive(d) && d.caps.sos) ||
      (minutesSince(f.bridgeSeenAt, now) < p.onlineMin.A && phones.some((d) => alive(d) && d.caps.sos))
    : minutesSince(f.bridgeSeenAt, now) < p.onlineMin.A;
  const phoneVoice = phoneUsable && (anyPhoneFact ? phones.some((d) => d.caps.voice) : true);
  const homeVoice = devices.some((d) => d.category === 'HOME_UNIT' && online(d) && d.caps.voice);

  const wornSos = worn.some((d) => d.caps.sos);
  const capabilities: CoverageCapabilities = {
    sos: wornSos || phoneUsable,
    fall: worn.some((d) => d.caps.fall),
    voice: worn.some((d) => d.caps.voice) || phoneVoice || homeVoice,
    location: devices.some((d) => online(d) && d.caps.location),
  };
  const rawLevel: CoverageResult['rawLevel'] =
    capabilities.fall && wornSos && capabilities.voice
      ? 'FULL'
      : wornSos && capabilities.voice
        ? 'BASIC'
        : phoneUsable
          ? 'PHONE_ONLY'
          : 'NONE';
  const level: CoverageLevel = ctx.night && rawLevel !== 'FULL' ? 'NIGHT' : rawLevel;

  const charging = alarm.filter((d) => d.charging);
  const pendingWear = alarm.filter((d) => !d.charging && d.chargeEndedAt && d.onBody !== true);
  const dead = alarm.filter((d) => !d.charging && !online(d) && d.batteryPct !== null && d.batteryPct <= ctx.deadPct);
  const reasons: CoverageReason[] = [];
  if (rawLevel !== 'FULL') {
    if (charging.length) reasons.push('WATCH_CHARGING');
    if (!worn.length && (!alarm.length || alarm.some((d) => online(d) && !d.charging && d.onBody !== true)))
      reasons.push('NO_ALARM_DEVICE_WORN');
    if (alarm.some((d) => !d.charging && !online(d))) reasons.push('ALARM_DEVICE_OFFLINE');
    if (!phoneUsable) reasons.push('PHONE_OFFLINE');
  }
  if (level === 'NIGHT') reasons.push('NIGHT_WINDOW');
  if (ctx.hold) reasons.push('ON_HOLD');
  // T-085 OEM (S2.7, S4.9): seviyeden bağımsız bilgi nedenleri. C sınıfı cihaz hiçbirini değiştirmez.
  const counted = devices.filter((d) => d.tier !== 'C');
  if (counted.some((d) => d.lineDown === true)) reasons.push('LINE_LOSS');
  if (counted.some((d) => d.category === 'HOME_UNIT' && d.powerLoss === true)) reasons.push('HOME_UNIT_POWER_LOSS');
  if (ctx.weakKinds?.size && counted.some((d) => !!d.kind && ctx.weakKinds!.has(d.kind)))
    reasons.push('PARTNER_LATENCY');
  const droppedPct = ctx.droppedPct ?? 20;
  const dropped = alarm.filter(
    (d) => !online(d) && !d.charging && d.onBody === true && d.batteryPct !== null && d.batteryPct > droppedPct,
  );
  return {
    level,
    rawLevel,
    reasons,
    capabilities,
    worn: worn.map((d) => d.id),
    phoneUsable,
    charging: charging.map((d) => d.id),
    pendingWear: pendingWear.map((d) => d.id),
    dead: dead.map((d) => d.id),
    // Son bilinen durum "çıkarıldı" (susmuş olsa da; sabah WATCH_OFF beklemesi buna göre açılır).
    offBody: !worn.length && alarm.some((d) => d.onBody === false && !d.charging && !d.chargeEndedAt),
    dropped: dropped.map((d) => d.id),
    anyOnline: phoneOnline(f, now, p) || devices.some(online),
  };
}

/** Eski koruma durumu (bir sürüm boyunca türetilir, S3.1). */
export function toProtectionState(level: CoverageLevel): ProtectionState {
  switch (level) {
    case 'FULL':
    case 'BASIC':
      return 'PROTECTED_WATCH';
    case 'PHONE_ONLY':
      return 'PROTECTED_PHONE';
    case 'NIGHT':
      return 'NIGHT';
    default:
      return 'UNPROTECTED';
  }
}

/** Uyum alanları: "saat" = en son görülen A sınıfı giyilebilir; telefon = telefon veya köprü. */
export function legacyFacts(f: Facts): {
  watchOnWrist: boolean | null;
  watchSeenAt: Date | null;
  phoneSeenAt: Date | null;
} {
  const devices = Object.values(f.devices);
  const watch = devices
    .filter((d) => isAlarmWearable(d) && d.seenAt)
    .sort((a, b) => (a.seenAt! < b.seenAt! ? 1 : -1))[0];
  const phone = devices
    .filter((d) => d.category === 'PHONE' && d.seenAt)
    .map((d) => d.seenAt!)
    .reduce<string | null>((m, s) => later(m, s), f.bridgeSeenAt);
  return {
    watchOnWrist: watch?.onBody ?? null,
    watchSeenAt: watch?.seenAt ? new Date(watch.seenAt) : null,
    phoneSeenAt: phone ? new Date(phone) : null,
  };
}

// ---- Uyanık süre: gece penceresi ve uyanış + resumeAfterWakeMin sayılmaz (S4.4) ----

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(at: Date, timeZone: string): Record<string, string> {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(timeZone, f);
  }
  return f.formatToParts(at).reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
}
/** Kişinin saat dilimindeki dakika (0–1439). */
export function localMinute(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  return Number(p.hour) * 60 + Number(p.minute);
}
/** Kişinin saat dilimindeki gün (YYYY-MM-DD). */
export function localDate(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
export const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
/** [start, end) dakika aralığında mı (gece yarısını aşabilir; start = end ise boş). */
export const inRange = (minute: number, start: number, end: number) =>
  start === end ? false : start < end ? minute >= start && minute < end : minute >= start || minute < end;

export interface QuietWindow {
  timezone: string;
  start: string;
  end: string;
  /** Uyanıştan sonra sessiz kalınan dk (S4.4: uyanış + 30 dk'da devam). */
  resumeAfterWakeMin: number;
}
const quietRange = (w: QuietWindow): [number, number] => [hhmm(w.start), (hhmm(w.end) + w.resumeAfterWakeMin) % 1440];
export function isQuiet(at: Date, w: QuietWindow): boolean {
  const [s, e] = quietRange(w);
  return inRange(localMinute(at, w.timezone), s, e);
}
/**
 * `from`–`to` arasındaki uyanık dakika (sessiz pencere dışı). Kişinin saat dilimindeki ofset `from` anına göre alınır
 * (yaz saati geçişindeki bir saatlik kayma kabul edilir; Türkiye'de yok).
 */
export function awakeMinutes(from: Date, to: Date, w: QuietWindow): number {
  const total = Math.floor((to.getTime() - from.getTime()) / 60_000);
  if (total <= 0) return 0;
  const [s, e] = quietRange(w);
  let perDay = 0;
  for (let m = 0; m < 1440; m++) if (!inRange(m, s, e)) perDay++;
  const days = Math.floor(total / 1440);
  const m0 = localMinute(from, w.timezone);
  let n = days * perDay;
  for (let i = days * 1440; i < total; i++) if (!inRange((m0 + i) % 1440, s, e)) n++;
  return n;
}

// ---- Şarj boşluğu (S4.4) ve "kapsama yok" (S4.7) zamanlayıcıları ----

/** S4.10 "hastanede / seyahatte" modu şu an açık mı (bitişi geçmişse kapalı: davranış kendiliğinden döner). */
export const onHold = (s: { holdUntil?: Date | null }, now: Date) => !!s.holdUntil && now < s.holdUntil;

export interface LadderState {
  gapSince: Date | null;
  gapCause: 'CHARGING' | 'BATTERY_DEAD' | null;
  gapOffPlan: boolean;
  gapSent: string[];
  noneSince: Date | null;
  noneSent: string[];
  intentUntil: Date | null;
}
export const emptyLadder = (): LadderState => ({
  gapSince: null,
  gapCause: null,
  gapOffPlan: false,
  gapSent: [],
  noneSince: null,
  noneSent: [],
  intentUntil: null,
});

export type LadderAction =
  | {
      kind: 'notify';
      code: string;
      audience: 'ELDER' | 'FAMILY';
      dedupeKey: string;
      vars?: Record<string, string | number>;
    }
  | { kind: 'gap-event'; reason: CoverageGapReason; sourceId: string }
  /** T-087 YERİNDE KONTROL (P2): boşluk başına bir kaynak; `since` boşluğun başı ("kimseye ulaşılamadı" denetimi). */
  | { kind: 'welfare-event'; reason: WelfareReason; sourceId: string; since: Date }
  | { kind: 'close-gap' };

export interface LadderCtx {
  personId: string;
  now: Date;
  quiet: QuietWindow;
  /** Kişinin şarj penceresi (HH:MM). */
  plan: { start: string; end: string };
  charging: ChargingParams;
  none: CoverageNoneParams;
  /** S4.10 "hastanede / seyahatte" modu: zamanlayıcılar sıfırlanır, hiçbir hatırlatma / olay üretilmez. */
  hold?: boolean;
}

const has = (sent: string[], k: string) => sent.includes(k);

/**
 * Zamanlayıcı adımı. Her şey tekrar ayıklamalıdır: gönderilen adım `*Sent`'e yazılır, bildirimlerin dedupeKey'i
 * bölüm başlangıcını taşır. Gece penceresinde (ve uyanış + resume) hiçbir şey gönderilmez; süreler uyanık dakikadır.
 */
export function stepLadders(
  prev: LadderState,
  cov: CoverageResult,
  f: Facts,
  ctx: LadderCtx,
): { state: LadderState; actions: LadderAction[] } {
  const { now, personId } = ctx;
  const s: LadderState = { ...prev, gapSent: [...prev.gapSent], noneSent: [...prev.noneSent] };
  const actions: LadderAction[] = [];
  const quiet = isQuiet(now, ctx.quiet);
  const intent = !!s.intentUntil && now < s.intentUntil;
  const awake = (from: Date) => awakeMinutes(from, now, ctx.quiet);
  const elder = (code: string, dedupeKey: string) =>
    actions.push({ kind: 'notify', code, audience: 'ELDER', dedupeKey });
  const wasActive = !!prev.gapSince || !!prev.noneSince;

  // S4.10: hastanede / seyahatte modunda kapsama uyarıları durur (SOS ve düşme olay motorunda her zaman çalışır).
  // Zamanlayıcılar sıfırlanır: mod bitince boşluk o andan sayılır (biriken uyarılar bir anda gitmez); aileye "geri
  // geldi" gitmez. Bekleyen / üstlenilmemiş kapsama olaylarını olay motoru kapatır (CoverageUpdate.hold).
  if (ctx.hold) {
    const held: LadderState = { ...emptyLadder(), intentUntil: s.intentUntil };
    if (held.intentUntil && now >= held.intentUntil) held.intentUntil = null;
    return { state: held, actions: [] };
  }

  // Şarj boşluğu: seviye FULL'un altında ve bir A sınıfı cihaz şarjda / şarjdan çıkıp takılmadı / pili bitti.
  const cause: LadderState['gapCause'] =
    cov.rawLevel === 'FULL'
      ? null
      : cov.charging.length || cov.pendingWear.length
        ? 'CHARGING'
        : cov.dead.length
          ? 'BATTERY_DEAD'
          : null;
  if (!cause) {
    s.gapSince = null;
    s.gapCause = null;
    s.gapOffPlan = false;
    s.gapSent = [];
  } else {
    if (!s.gapSince) {
      const deadSeen = cov.dead
        .map((id) => f.devices[id]?.seenAt)
        .filter((x): x is string => !!x)
        .sort()[0];
      s.gapSince = cause === 'BATTERY_DEAD' && deadSeen ? new Date(deadSeen) : now;
      s.gapOffPlan = !inRange(localMinute(s.gapSince, ctx.quiet.timezone), hhmm(ctx.plan.start), hhmm(ctx.plan.end));
    }
    s.gapCause = cause;
    const gapKey = s.gapSince.toISOString();
    if (!quiet) {
      if (cause === 'CHARGING') {
        if (cov.rawLevel === 'NONE' && !has(s.gapSent, 'cover')) {
          s.gapSent.push('cover');
          elder('P-CHARGE-COVER', `charge-cover:${personId}:${gapKey}`);
        }
        for (const id of cov.charging) {
          const d = f.devices[id]!;
          const pct = d.batteryPct ?? 0;
          const k = `done:${id}:${d.chargingSince}`;
          const enough =
            pct >= 100 ||
            (pct >= ctx.charging.chargeDonePct && minutesSince(d.chargingSince, now) >= ctx.charging.chargeDoneMin);
          if (enough && !has(s.gapSent, k)) {
            s.gapSent.push(k);
            elder('W-CHARGE-DONE', `${k}`);
            elder('P-CHARGE-DONE', `${k}`);
          }
        }
        if (!intent)
          for (const id of cov.pendingWear) {
            const d = f.devices[id]!;
            ctx.charging.putOnMin.forEach((m, i) => {
              const k = `wear${i + 1}:${id}:${d.chargeEndedAt}`;
              if (has(s.gapSent, k) || awake(new Date(d.chargeEndedAt!)) < m) return;
              s.gapSent.push(k);
              elder('W-WEAR-REMIND', k);
              elder('P-WEAR-REMIND', k);
            });
          }
        const familyMin = s.gapOffPlan ? ctx.charging.familyGapOffPlanMin : ctx.charging.familyGapMin;
        const gapMin = awake(s.gapSince);
        if (!intent && !has(s.gapSent, 'family') && gapMin >= familyMin) {
          s.gapSent.push('family');
          actions.push({
            kind: 'notify',
            code: 'F-CHARGE-GAP',
            audience: 'FAMILY',
            // Günde en çok bir (S4.4).
            dedupeKey: `charge-gap:${personId}:${localDate(now, ctx.quiet.timezone)}`,
            vars: { min: gapMin },
          });
        }
      }
      // Olay her değerlendirmede istenir; olay motoru aynı kaynağı ikinci kez açmaz (başka olaya eklenip o kapanırsa
      // kaynak serbest kalır ve yeniden açılır — AbsorbedSourceService).
      if (awake(s.gapSince) >= ctx.charging.maxGapMin)
        actions.push({ kind: 'gap-event', reason: cause, sourceId: `coverage-gap:${personId}:${gapKey}` });
    }
  }

  // Kapsama yok (S4.7): hiçbir SOS yolu yok; uyanık 20 dk hatırlatma, 45 dk aile, 60 dk KAPSAMA BOŞLUĞU. Hiç cihazı
  // bilinmeyen kişide (henüz sinyal yok / tüm cihazlar kaldırıldı) zamanlayıcı işlemez.
  const known = Object.keys(f.devices).length > 0 || !!f.bridgeSeenAt;
  if (cov.rawLevel !== 'NONE' || !known) {
    if (s.noneSince && has(s.noneSent, 'family'))
      actions.push({
        kind: 'notify',
        code: 'F-COVERAGE-BACK',
        audience: 'FAMILY',
        dedupeKey: `coverage-back:${personId}:${s.noneSince.toISOString()}`,
      });
    s.noneSince = null;
    s.noneSent = [];
  } else {
    if (!s.noneSince) s.noneSince = now;
    const key = s.noneSince.toISOString();
    const min = awake(s.noneSince);
    if (!quiet) {
      if (!has(s.noneSent, 'remind') && min >= ctx.none.remindMin) {
        s.noneSent.push('remind');
        elder('P-COVERAGE-NONE', `coverage-none:${personId}:${key}`);
        elder('W-WEAR-REMIND', `coverage-none:${personId}:${key}`);
        // S4.7: yaşlının numarasına otomatik sesli arama (bildirim modülü, CPaaS; boşluk başına bir, gece asla).
        elder('V-COVERAGE-NONE', `coverage-none:${personId}:${key}`);
      }
      if (!has(s.noneSent, 'family') && min >= ctx.none.familyMin) {
        s.noneSent.push('family');
        actions.push({
          kind: 'notify',
          code: 'F-COVERAGE-NONE',
          audience: 'FAMILY',
          dedupeKey: `coverage-none:${personId}:${key}`,
        });
      }
      if (min >= ctx.none.eventMin)
        actions.push({ kind: 'gap-event', reason: noneReason(cov), sourceId: `coverage-none:${personId}:${key}` });
      // T-087 YERİNDE KONTROL (P2): takılı cihaz pili yeterliyken birden sustu (2 sa) veya telefon dahil tüm cihazlar
      // sessiz (6 sa). Boşluk başına tek kaynak: olay motoru aynı kaynağı ikinci kez açmaz (bir kişide tek açık olay).
      const reason: WelfareReason | null =
        cov.dropped.length && min >= ctx.none.welfareDroppedH * 60
          ? 'DEVICE_DROPPED'
          : !cov.anyOnline && min >= ctx.none.welfareSilentH * 60
            ? 'ALL_SILENT'
            : null;
      if (reason)
        actions.push({ kind: 'welfare-event', reason, sourceId: `welfare:${personId}:${key}`, since: s.noneSince });
    }
  }

  if (wasActive && !s.gapSince && !s.noneSince) actions.push({ kind: 'close-gap' });
  if (s.intentUntil && now >= s.intentUntil) s.intentUntil = null;
  return { state: s, actions };
}

/** Kapsama yokken boşluğun nedeni (eski olay türleri artık KAPSAMA BOŞLUĞU'nun nedenidir). */
export function noneReason(cov: CoverageResult): CoverageGapReason {
  if (cov.charging.length || cov.pendingWear.length) return 'CHARGING';
  if (cov.dead.length) return 'BATTERY_DEAD';
  if (cov.offBody) return 'WATCH_OFF';
  return 'CONNECTION_LOST';
}

// ---- 18:00 planlı şarj kontrolü (S4.6) ----

export interface PlanCheckCtx {
  personId: string;
  now: Date;
  timezone: string;
  planHour: string;
  planPct: number;
  familyPct: number;
  /** Bir sonraki şarj penceresinin başlangıcı (HH:MM). */
  windowStart: string;
  params: CoverageParams;
}

/**
 * Günde bir kez, planHour'dan sonraki ilk saat içinde: bir A sınıfı cihaz planPct'nin altındaysa veya tahmini kalan
 * süresi bir sonraki şarj penceresine yetmiyorsa kişiye "şimdi şarj edin"; familyPct'nin altındaysa aileye de.
 * Yapılması gerekmiyorsa null; yapıldıysa (bildirim olsun olmasın) o günün tarihi ve bildirimler.
 */
export function planCheck(
  f: Facts,
  checkedOn: string | null,
  ctx: PlanCheckCtx,
): { checkedOn: string; actions: LadderAction[] } | null {
  const today = localDate(ctx.now, ctx.timezone);
  const minute = localMinute(ctx.now, ctx.timezone);
  const start = hhmm(ctx.planHour);
  if (checkedOn === today || !inRange(minute, start, (start + 60) % 1440)) return null;
  const untilWindowH = ((hhmm(ctx.windowStart) - minute + 1440) % 1440 || 1440) / 60;
  const actions: LadderAction[] = [];
  let low: number | null = null;
  let familyLow: number | null = null;
  for (const d of Object.values(f.devices)) {
    if (!isAlarmWearable(d) || d.charging || d.batteryPct === null || !deviceOnline(d, f, ctx.now, ctx.params))
      continue;
    const hoursLeft = d.batteryLifeH ? (d.batteryPct / 100) * d.batteryLifeH : null;
    if (d.batteryPct < ctx.planPct || (hoursLeft !== null && hoursLeft < untilWindowH))
      low = Math.min(low ?? 100, d.batteryPct);
    if (d.batteryPct < ctx.familyPct) familyLow = Math.min(familyLow ?? 100, d.batteryPct);
  }
  const key = `bat-plan:${ctx.personId}:${today}`;
  if (low !== null) {
    actions.push({ kind: 'notify', code: 'P-CHARGE-NOW', audience: 'ELDER', dedupeKey: key });
    actions.push({ kind: 'notify', code: 'W-BAT-PLAN', audience: 'ELDER', dedupeKey: key });
  }
  if (familyLow !== null)
    actions.push({ kind: 'notify', code: 'F-BAT-PLAN', audience: 'FAMILY', dedupeKey: key, vars: { pct: familyLow } });
  return { checkedOn: today, actions };
}

/** Sesli arama sırası adayı (yalnız sesli görüşmesi olan cihazlar). `manual`: aile/operatörün verdiği sıra. */
export interface VoiceCandidate {
  id: string;
  category: DeviceCategory;
  online: boolean;
  onBody: boolean | null;
  charging: boolean;
  seenAt: string | null;
  manual: number | null;
}

/**
 * S1.8 sesli arama sırası (kimlikler, ilk aranacak önce). Elle verilenler önce, kendi numaralarıyla. Sonra:
 * şu an takılı (çevrimiçi, şarjda değil) giyilebilirler → takılı bilgisi olmayan çevrimiçi giyilebilirler (takılı
 * algılaması olmayan kolye) → ev ünitesi hoparlörü → telefon → kalanlar (şarjdaki, çıkarılmış, çevrimdışı; yine
 * giyilebilir > ev ünitesi > telefon). Her grupta en son görülen önce. Şarjdaki / çıkarılmış saat telefonun önüne
 * geçmez (PR #50 hatası: kategori "takılı"dan önce sıralanıyordu).
 */
export function voiceOrderOf(list: VoiceCandidate[]): string[] {
  const cat = (c: VoiceCandidate) => (isWearable(c) ? 0 : c.category === 'HOME_UNIT' ? 1 : 2);
  const group = (c: VoiceCandidate) => {
    const usable = c.online && !c.charging;
    if (usable && isWearable(c) && c.onBody === true) return 0;
    if (usable && isWearable(c) && c.onBody === null) return 1;
    if (usable && !isWearable(c)) return 2 + cat(c); // ev ünitesi 3, telefon 4
    return 10 + cat(c);
  };
  const key = (c: VoiceCandidate) => [c.manual ?? 100, group(c), -(c.seenAt ? Date.parse(c.seenAt) : 0)];
  return [...list]
    .sort((a, b) => {
      const [ka, kb] = [key(a), key(b)];
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((c) => c.id);
}

/** Tahmini kalan saat (S4.2): pil % × katalogdaki pil ömrü; şarjdaysa veya bilinmiyorsa null. */
export function estimatedHoursLeft(d: Pick<DeviceFact, 'batteryPct' | 'batteryLifeH' | 'charging'>): number | null {
  if (d.charging || d.batteryPct === null || !d.batteryLifeH) return null;
  return Math.round((d.batteryPct / 100) * d.batteryLifeH * 10) / 10;
}
