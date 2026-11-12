// 03-teknik-mimari.md "Sinyal ve olay şemaları" ile birebir; şema dosyaları schemas/ altındadır.
export type SignalKind =
  | 'SOS'
  | 'FALL'
  | 'CANCEL'
  | 'OK'
  | 'HEART_RATE'
  | 'STEPS'
  | 'INACTIVITY'
  | 'OFF_BODY'
  | 'ON_BODY'
  | 'BATTERY'
  | 'LOCATION'
  | 'HEARTBEAT'
  | 'CALLBACK_REQUEST'
  | 'TEST'
  /** T-086 (S4.2): cihaz şarja girdi / şarjdan çıktı. */
  | 'CHARGE_START'
  | 'CHARGE_END';

export interface Signal {
  schemaVersion: 1;
  idempotencyKey: string;
  deviceId: string;
  protectedPersonId: string;
  kind: SignalKind;
  occurredAt: string;
  receivedAt?: string | null;
  value?: number | null;
  location?: { lat: number; lng: number; accuracyM?: number; source?: 'GPS' | 'NETWORK' | 'PHONE' } | null;
  device?: {
    batteryPct?: number;
    onWrist?: boolean;
    connectivity?: 'BLE' | 'LTE' | 'WIFI' | 'NONE';
    appVersion?: string;
    /** T-086: cihaz şu an şarjda mı. Şarjdaki cihazın düşmesi yok sayılır (S3.4), pil uyarıları susar. */
    charging?: boolean;
  };
  payload?: Record<string, unknown>;
  /**
   * Sunucu doldurur (T-015, cihaz adaptörü); istemci gönderemez (şema additionalProperties: false).
   * Olay motoru cihaz türünü buradan okur, cihaz tablosundan değil.
   */
  source?: SignalSource;
}

/**
 * Sunucunun sinyale eklediği cihaz profili (T-015 adaptör + T-085 cihaz kataloğu). Olay motoru cihaz modelini
 * bilmez; kapsama hesabı yalnız bu alanları kullanır. Eski kayıtlarda yalnız kind/role bulunabilir.
 */
export interface SignalSource {
  kind: DeviceKind;
  role: DeviceRole;
  category?: DeviceCategory;
  tier?: DeviceTier;
  caps?: CoverageCapabilities;
  /** Katalogdaki tam pil ömrü (saat); tahmini kalan süre = pil % × bu değer. */
  batteryLifeH?: number | null;
}

export type EventType =
  | 'SOS'
  | 'FALL'
  | 'INACTIVITY'
  | 'CALLBACK'
  | 'WATCH_OFF'
  | 'BATTERY_LOW'
  | 'BATTERY_DEAD'
  | 'CONNECTION_LOST'
  | 'ROUTINE_DEVIATION'
  | 'HEART_ANOMALY'
  | 'TEST'
  | 'FOLLOW_UP'
  /** T-086 (S4.4, S4.7): kapsama boşluğu; nedenleri CHARGING, WATCH_OFF, BATTERY_DEAD, CONNECTION_LOST. */
  | 'COVERAGE_GAP'
  /** T-087 (S4.7, S5.4): yerinde kontrol (P2); nedeni WelfareReason. */
  | 'WELFARE_CHECK';

/**
 * WELFARE_CHECK nedeni: DEVICE_DROPPED kapsama YOK iken takılı cihaz pili yeterliyken birden sustu (2 sa);
 * ALL_SILENT telefon dahil tüm cihazlar sessiz ve kimseye ulaşılamadı (6 sa); NO_MOVEMENT yanınızdayız araması
 * cevapsız ve 24 sa cihaz hareketi yok.
 */
export type WelfareReason = 'DEVICE_DROPPED' | 'ALL_SILENT' | 'NO_MOVEMENT';

/** COVERAGE_GAP olayının nedeni (eski WATCH_OFF / BATTERY_DEAD / CONNECTION_LOST tespitleri bunun nedenidir). */
export type CoverageGapReason = 'CHARGING' | 'WATCH_OFF' | 'BATTERY_DEAD' | 'CONNECTION_LOST';

export type EventState =
  | 'CREATED'
  | 'DEVICE_PROMPT'
  | 'CANCELLED_BY_USER'
  | 'ESCALATED'
  | 'OPERATOR_QUEUE'
  | 'OPERATOR_ASSIGNED'
  | 'CONTACT_CHAIN'
  | 'CONFIRMED_OK'
  | 'CONFIRMED_EMERGENCY'
  | 'DISPATCH'
  | 'FOLLOW_UP'
  | 'CLOSED';

/** Kayıtlı cihaz türü (device.device.kind). Yeni tür = yeni DeviceAdapter (T-015). */
export type DeviceKind = 'WEAROS_WATCH' | 'ANDROID_PHONE' | 'IOS_PHONE' | 'SIMULATOR';
export type DeviceRole = 'WATCH' | 'PHONE';

/** Eski koruma durumu: bir sürüm boyunca kapsama seviyesinden türetilir (S3.1). */
export type ProtectionState = 'PROTECTED_WATCH' | 'PROTECTED_PHONE' | 'NIGHT' | 'UNPROTECTED';

// ---- T-085 çoklu cihaz ve kapsama (docs/07 S1, S3) ----
export type DeviceCategory = 'WATCH' | 'PHONE' | 'PENDANT' | 'RING' | 'EARBUD' | 'EARRING' | 'HOME_UNIT' | 'CLOUD';
/** A alarm (SOS/düşme açar, korumaya sayılır), B canlı izlem, C eğilim (S2.1). */
export type DeviceTier = 'A' | 'B' | 'C';
export type BodyLocation = 'WRIST_LEFT' | 'WRIST_RIGHT' | 'NECK' | 'CHEST' | 'FINGER' | 'EAR' | 'POCKET' | 'HOME';
export type CoverageLevel = 'FULL' | 'BASIC' | 'PHONE_ONLY' | 'NIGHT' | 'NONE';
export type CoverageReason =
  'WATCH_CHARGING' | 'NO_ALARM_DEVICE_WORN' | 'ALARM_DEVICE_OFFLINE' | 'PHONE_OFFLINE' | 'NIGHT_WINDOW' | 'ON_HOLD';
export interface CoverageCapabilities {
  sos: boolean;
  fall: boolean;
  voice: boolean;
  location: boolean;
}

/** GET /protected-persons/{id}/devices öğesi. */
export interface DeviceSummary {
  id: string;
  kind: string;
  category: DeviceCategory;
  tier: DeviceTier;
  bodyLocation: BodyLocation | null;
  nickname: string | null;
  online: boolean;
  lastSeenAt: string | null;
  batteryPct: number | null;
  charging: boolean;
  chargingSince: string | null;
  onBody: boolean | null;
  estimatedHoursLeft: number | null;
  voiceOrder: number | null;
  /** Sesli arama sırası aile / operatör tarafından elle verildi (PATCH voiceOrder); false: hesaplanan sıra. */
  voiceOrderManual: boolean;
  /** T-087 (S5.2): cihaza özel sesli arama numarasının son iki hanesi (operasyon PATCH voiceNumber); yoksa null. */
  voiceNumberLast2?: string | null;
  /** T-089 (S7.1, S4.8): son sinyali yaşlının telefonu üzerinden (BLE köprüsü) geldi — "telefon üzerinden". */
  bridged?: boolean;
}

/** GET /protected-persons/{id}/coverage */
export interface CoverageView {
  level: CoverageLevel;
  since: string;
  reasons: CoverageReason[];
  capabilities: CoverageCapabilities;
  devices: DeviceSummary[];
  /** S4.10 kronik boşluk: 7 günde 5 boşluktan sonra P3 yerine plan (aile + operasyon takibi); yoksa null. */
  chronicGap?: { since: string } | null;
  /** S4.10 kişiye özel tolerans (dk), KAPSAMA BOŞLUĞU olay eşiğine eklenir. */
  toleranceMin?: number;
}

/** GET|PUT /protected-persons/{id}/charging-plan */
export interface ChargingPlan {
  window: string;
  source: 'DEFAULT' | 'LEARNED' | 'FAMILY';
  nightChargeAllowed: boolean;
  /** T-086 (S4.3): öğrenilmiş pencerenin dayandığı geçerli gün sayısı ve zamanı (LEARNED değilse null). */
  learnedDays?: number | null;
  learnedAt?: string | null;
}

/** GET /supervisor/coverage (S4.11): seviye başına kişi sayısı; akşam planlı şarj ayrı sayılır. */
export interface SupervisorCoverage {
  counts: Record<CoverageLevel, number>;
  plannedCharging: number;
  total: number;
  at: string;
}

/** T-085 (S7.3, S7.4) kapsama zaman çizelgesi dilimi; hold: "hastanede / seyahatte" modu. */
export interface CoverageSegment {
  from: string;
  to: string;
  level: CoverageLevel;
  hold: boolean;
}
/**
 * Kişinin yerel günü başına uyanık (gece penceresi dışı) dakika dağılımı. Yüzdeler (0–100, bir ondalık) korunan
 * (FULL/BASIC) + yalnız telefon + YOK toplamına göredir; hold ve bilinmeyen dakikalar girmez; ölçülemediyse null.
 */
export interface CoverageDay {
  date: string;
  awakeMin: number;
  protectedMin: number;
  phoneOnlyMin: number;
  noneMin: number;
  holdMin: number;
  unknownMin: number;
  protectedPct: number | null;
  phoneOnlyPct: number | null;
  nonePct: number | null;
}
/** GET /protected-persons/{id}/coverage/history?days=7 — aile uygulamasının "son 7 günün kapsama zaman çizelgesi". */
export interface CoverageHistory {
  protectedPersonId: string;
  days: number;
  from: string;
  to: string;
  timezone: string;
  sleepWindow: { start: string; end: string };
  segments: CoverageSegment[];
  daily: CoverageDay[];
  summary: Omit<CoverageDay, 'date'>;
}

/** GET /supervisor/coverage/board (S7.2): amirin kapsama panosu listeleri. */
export interface SupervisorCoverageBoard {
  at: string;
  /** Uyanıkken kapsama YOK ≥ coverageNone.remindMin (20 dk), en uzun önce. Hold'dakiler yok. */
  noneAwake: { protectedPersonId: string; name: string | null; since: string; awakeMin: number; reasons: string[] }[];
  /** Son 7 günde uyanık zamanın chronicGap.protectedPct'sinden (%80) azı korunanlar ve kronik boşluk işaretliler. */
  chronic: {
    protectedPersonId: string;
    name: string | null;
    protectedPct: number | null;
    chronicSince: string | null;
    toleranceMin: number;
  }[];
  /** Yaşlının telefonu çevrimdışı ve üzerinden (BLE) bağlanan cihazlar var: hepsi birlikte düştü (S4.8). */
  offlineBridges: {
    protectedPersonId: string;
    name: string | null;
    phoneSeenAt: string | null;
    bridgedDevices: number;
  }[];
  /** Ulaşılamama oranı (P1/P2 merdivenleri, test hariç): adım türü başına deneme / ulaşılan / ulaşılamayan. */
  unreachable: { days7: LadderStepStat[]; days30: LadderStepStat[] };
  /** 90 sn üstlenilmeyen P1 (O-P1-UNCLAIMED), son 7 gün. */
  unclaimedP1: { eventId: string; eventType: string; at: string; acked: boolean }[];
  /** Hareketsizlik / yerinde kontrol olaylarında 112 bildirimi, son 7 gün. */
  dispatch112: { eventId: string; eventType: string; notifiedAt: string; status: string; name: string | null }[];
}
export interface LadderStepStat {
  /** Adım türü (CALL_WATCH, CALL_PHONE, CALL_CONTACT:1 …). */
  step: string;
  attempted: number;
  reached: number;
  unreached: number;
  offlineSkipped: number;
  /** (ulaşılamayan + çevrimdışı atlanan) / deneme; deneme yoksa null. */
  unreachableRate: number | null;
  /** Merdivenin son denenen adımı buysa ve kimseye ulaşılamadıysa (merdiven burada takıldı). */
  stalledHere: number;
}

/** GET /admin/coverage-metrics (S7.3): yalnız toplamlar, kişisel veri yok. */
export interface AdminCoverageMetrics {
  days: number;
  from: string;
  to: string;
  coverage: {
    personDays: number;
    avgProtectedPct: number | null;
    medianProtectedPct: number | null;
    /** Korunan payı %80'in altında kalan kişi-gün oranı (0–1). */
    belowTargetShare: number | null;
    buckets: { label: string; n: number }[];
  };
  falseAlarms: { model: string; appVersion: string; events: number; falseAlarms: number; rate: number }[];
  latency: { tier: string; adapter: string; signals: number; p50Sec: number | null; p95Sec: number | null }[];
  charging: {
    sessions: number;
    worn: number;
    medianToWearMin: number | null;
    p90ToWearMin: number | null;
    /** İlk hatırlatmadan (15 dk) önce takılanların oranı (0–1). */
    beforeReminderShare: number | null;
  };
  eventsPer100PersonDays: Record<string, number>;
  battery: { model: string; devices: number; deviceDays: number; medianDailyDrainPct: number | null }[];
}

export interface KafkaEnvelope<T> {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  countryCode: string;
  subjectUserId: string;
  payload: T;
}

export const TOPICS = {
  signalReceived: 'signal.received',
  eventCreated: 'event.created',
  eventTransitioned: 'event.transitioned',
  eventClosed: 'event.closed',
  eventUpdated: 'event.updated',
  notifyRequested: 'notify.requested',
  rulesReloaded: 'rules.reloaded',
  protectionChanged: 'user.protection.changed',
  /** T-085: kişinin kapsama seviyesi değişti (FULL / BASIC / PHONE_ONLY / NIGHT / NONE). */
  coverageChanged: 'user.coverage.changed',
  chainStepResult: 'chain.step.result',
  devicePromptAnswered: 'device.prompt.answered',
  /** Amir uyarısı (T-021: operatör kilidi düştü). Konsol amir odasına yayınlar. */
  supervisorAlert: 'supervisor.alert',
  /** T-071 (D-07): yanlış alarm kaydı (kişi, olay, neden). */
  eventFalseAlarm: 'event.false_alarm',
} as const;

/** Bildirim isteği (T-012 üretir, T-053 notify modülü tüketir). Metin değil, katalog kodu taşır. */
export interface NotifyRequest {
  code: string;
  audience: 'ELDER' | 'FAMILY';
  protectedPersonId: string;
  /** Tüketici tekrarı ayıklasın: aynı kaynak + kod bir kez gönderilir. */
  dedupeKey: string;
  eventId?: string;
  vars?: Record<string, string | number>;
}

// ---- T-021 zincir (D-03, D-04) ----
/**
 * Adım sonucu. T-087 (docs/07 S5.1): SILENT = otomatik cevapla bağlandı ama ses yok (olası acil durum, "cevap yok"
 * değil); OFFLINE_SKIPPED = cihaz son 15 dk görülmedi, sistem aramadan atladı (operatör giremez).
 */
export type StepResult = 'REACHED' | 'NO_ANSWER' | 'BUSY' | 'WRONG_NUMBER' | 'SKIPPED' | 'SILENT' | 'OFFLINE_SKIPPED';
/** Operatörün girebileceği sonuçlar (OFFLINE_SKIPPED yalnız sistem). */
export const STEP_RESULTS: readonly StepResult[] = [
  'REACHED',
  'NO_ANSWER',
  'BUSY',
  'WRONG_NUMBER',
  'SKIPPED',
  'SILENT',
];
/** Ulaşılınca operatörün değerlendirmesi: OK → CONFIRMED_OK, EMERGENCY → CONFIRMED_EMERGENCY. */
export type StepAssessment = 'OK' | 'EMERGENCY';
/** VOICE_DEVICE: en iyi sesli cihaz (yeniden arama); KEY_HOLDER: anahtarı olan yakın (T-087). */
export type StepTarget =
  'WATCH' | 'ELDER_PHONE' | 'VOICE_DEVICE' | 'CONTACT' | 'KEY_HOLDER' | 'NEIGHBOR' | 'EMERGENCY' | 'FAMILY';

export interface ChainStep {
  n: number;
  /** Kural paketindeki adım türü (CALL_WATCH, CALL_CONTACT, CALL_112 …). */
  kind: string;
  target: StepTarget;
  /** CALL_CONTACT:2 → 2. */
  contactIndex?: number;
  /** Katalog kodları (konsol metni buradan). */
  label: string;
  script?: string;
  timeoutSec: number;
  required: boolean;
  /** T-087: P1 sesli cihaz aramasında cihaz bu sürede kendiliğinden cevaplar (sn). */
  autoAnswerSec?: number;
  calledAt?: string;
  result?: StepResult;
  assessment?: StepAssessment;
  note?: string;
  reason?: string;
  operatorId?: string;
  completedAt?: string;
  scriptReadAt?: string;
}

export interface ChainView {
  procedureVersion: number;
  steps: ChainStep[];
  /** Sıradaki adım; hepsi bittiyse null. */
  current: number | null;
}

/** T-087/T-088 (docs/07 S5, S3.3): konsolun olay ekranındaki merdiven özeti. */
export interface LadderView {
  /** Kuyruğa düşüş + kural paketinin 112 son sınırı; sınır yoksa (tür/test) null. */
  call112DeadlineAt: string | null;
  call112DeadlineSec: number | null;
  /** İki farklı cihaz 90 sn içinde düşme bildirdi. */
  corroborated: boolean;
  /** Olayı bildiren farklı cihaz sayısı ("2 cihaz"). */
  sourceDeviceCount: number;
  /** Olayı iptal eden cihaz (kapanmış olayda). */
  cancelledByDeviceId: string | null;
  /** Otomatik cevaplanan bir arama sessiz kaldı (işitme/konuşma güçlüğü yoksa). */
  possibleEmergency: boolean;
  /** Kişide işitme/konuşma güçlüğü işaretli. */
  hearingSpeechImpaired: boolean;
  /** Kaynak platformun kendi SOS akışını (ör. Apple düşme → 112) çalıştırdığını bildirdi. */
  platformSosFlow: boolean;
  /** T-087: YERİNDE KONTROL nedeni (WELFARE_CHECK değilse null). */
  welfareReason?: WelfareReason | null;
  /** T-089: operatörün "Soru gönder" komutları ve cihazın cevabı (eskiden yeniye). */
  prompts?: DevicePromptView[];
}

/**
 * T-089 (S7.1) operatörün cihaza sorusu ve cevabı. answer: OK ("İyiyim"), HELP (soru penceresinde SOS), NO_ANSWER
 * (until geçti, cevap yok), null (bekleniyor).
 */
export interface DevicePromptView {
  deviceId: string;
  sentAt: string;
  until: string;
  /** Soru cihaza (veya köprü telefona) ulaştı. */
  delivered: boolean;
  answer: 'OK' | 'HELP' | 'NO_ANSWER' | null;
  answeredAt: string | null;
  /** Cevaplayan cihaz (soru telefona gidip saatten cevaplanabilir). */
  answeredByDeviceId: string | null;
}

export interface SupervisorAlert {
  code: string;
  eventId: string;
  eventType: EventType;
  operatorId?: string;
  at: string;
}

// ---- T-071 yanlış alarm (D-07, C-12) ----
/** USER_CANCEL: kişi cihazdan iptal etti; OPERATOR: operatör FALSE_ALARM ile kapattı; FAMILY_FEEDBACK: aile "gerçek değildi". */
export type FalseAlarmCause = 'USER_CANCEL' | 'OPERATOR' | 'FAMILY_FEEDBACK';
export interface FalseAlarm {
  protectedPersonId: string;
  eventId: string;
  eventType: EventType;
  cause: FalseAlarmCause;
  at: string;
}
