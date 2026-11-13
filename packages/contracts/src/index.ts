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
  | 'CHARGE_END'
  /** T-092 (docs/07 S6.2): oksijen doygunluğu (value %, `vital.quality` Q1–Q3). */
  | 'SPO2'
  /** T-092: cilt sıcaklığı sapması (value °C, cihazın kendi gece tabanına göre; gecede bir). */
  | 'SKIN_TEMP_DEVIATION';

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
    /** T-085 OEM (S4.9): ev ünitesi şebeke elektriğinde mi; false = elektrik kesildi, yedek pilde (kapsama nedeni). */
    mainsPower?: boolean;
    /** T-085 OEM (S4.9): üreticinin bildirdiği hat (hücresel / ev ünitesi hattı); false = hat düştü (cihaz çevrimdışı). */
    lineOk?: boolean;
  };
  payload?: Record<string, unknown>;
  /** T-092 (S6.3, S6.6): değer ölçümünün kalite sınıfı ve bağlamı (HEART_RATE, SPO2). İsteğe bağlı. */
  vital?: VitalMeta;
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
  /** T-085 OEM: kayıttaki bağlantı yolu (ev ünitesi üzerinden gelen kolye, hattı düşen ev ünitesiyle birlikte düşer). */
  connectionPath?: ConnectionPath;
}

/** Cihazın sunucuya ulaştığı yol (S1.6; device.device.connection_path). */
export type ConnectionPath = 'DIRECT' | 'PHONE_BRIDGE' | 'HOME_UNIT' | 'VENDOR_CLOUD' | 'PARTNER_CENTER';

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
  | 'WELFARE_CHECK'
  /** T-092 (S6.4): alışılmadık oksijen okuması (P3; nabız ≥120 ile P2). Bayrakla kapalı. */
  | 'SPO2_LOW';

/**
 * WELFARE_CHECK nedeni: DEVICE_DROPPED kapsama YOK iken takılı cihaz pili yeterliyken birden sustu (2 sa);
 * ALL_SILENT telefon dahil tüm cihazlar sessiz ve kimseye ulaşılamadı (6 sa); NO_MOVEMENT yanınızdayız araması
 * cevapsız ve 24 sa cihaz hareketi yok.
 */
export type WelfareReason = 'DEVICE_DROPPED' | 'ALL_SILENT' | 'NO_MOVEMENT';

/**
 * COVERAGE_GAP olayının nedeni (eski WATCH_OFF / BATTERY_DEAD / CONNECTION_LOST tespitleri bunun nedenidir).
 * NOT_WORN (T-085 OEM, S4.9): üretici "kolye N gündür takılmadı" bildirdi (OFF_BODY, value = gün).
 */
export type CoverageGapReason = 'CHARGING' | 'WATCH_OFF' | 'BATTERY_DEAD' | 'CONNECTION_LOST' | 'NOT_WORN';

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

/**
 * Kayıtlı cihaz türü (device.device.kind). Yeni tür = yeni DeviceAdapter (T-015). OEM ortak cihazlarında tür ortak
 * kodudur (T-085, S2.5): FAKE_PENDANT test / geliştirme için sahte hücresel ve radyo kolye ortağı; BLE köprülü
 * modeller T-092 (telefon köprüsü).
 */
export type DeviceKind =
  'WEAROS_WATCH' | 'ANDROID_PHONE' | 'IOS_PHONE' | 'SIMULATOR' | 'FAKE_PENDANT' | BridgedDeviceModel;
export type DeviceRole = 'WATCH' | 'PHONE';

/** Eski koruma durumu: bir sürüm boyunca kapsama seviyesinden türetilir (S3.1). */
export type ProtectionState = 'PROTECTED_WATCH' | 'PROTECTED_PHONE' | 'NIGHT' | 'UNPROTECTED';

// ---- T-085 çoklu cihaz ve kapsama (docs/07 S1, S3) ----
export type DeviceCategory =
  | 'WATCH'
  | 'PHONE'
  | 'PENDANT'
  | 'RING'
  | 'EARBUD'
  | 'EARRING'
  | 'HOME_UNIT'
  | 'CLOUD'
  /** T-092: telefona BLE ile bağlı tek amaçlı ölçüm cihazı (nabız kemeri, parmak oksimetre, termometre). */
  | 'SENSOR';
/** A alarm (SOS/düşme açar, korumaya sayılır), B canlı izlem, C eğilim (S2.1). */
export type DeviceTier = 'A' | 'B' | 'C';
export type BodyLocation = 'WRIST_LEFT' | 'WRIST_RIGHT' | 'NECK' | 'CHEST' | 'FINGER' | 'EAR' | 'POCKET' | 'HOME';
export type CoverageLevel = 'FULL' | 'BASIC' | 'PHONE_ONLY' | 'NIGHT' | 'NONE';
/**
 * T-085 OEM (S2.7, S4.9): PARTNER_LATENCY ortağın gecikmesi 1 sa boyunca p99 60 sn'yi aştı, o ortağın cihazları
 * "zayıf"; HOME_UNIT_POWER_LOSS ev ünitesinin elektriği kesildi (yedek pilde); LINE_LOSS kolyenin / ev ünitesinin
 * hattı düştü (cihaz ve ona bağlı radyo kolye çevrimdışı). Üçü de seviyeden bağımsız bilgi nedenidir.
 */
export type CoverageReason =
  | 'WATCH_CHARGING'
  | 'NO_ALARM_DEVICE_WORN'
  | 'ALARM_DEVICE_OFFLINE'
  | 'PHONE_OFFLINE'
  | 'NIGHT_WINDOW'
  | 'ON_HOLD'
  | 'PARTNER_LATENCY'
  | 'HOME_UNIT_POWER_LOSS'
  | 'LINE_LOSS';
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

// ---- T-085 OEM ortak cihazları (docs/07 S2.5–S2.7, S4.9) ----
/** Ortak webhook'unda sinyal başına ret: SignalRejectReason'a ek olarak bilinmeyen cihaz / okunamayan olay. */
export type PartnerRejectReason = 'SCHEMA_INVALID' | 'UNSUPPORTED_SIGNAL' | 'UNKNOWN_DEVICE' | 'EVENT_INVALID';

/** POST /webhooks/partners/{partner} yanıtı (202). `rejected` üreticinin olay kimliğiyle. */
export interface PartnerWebhookResult {
  accepted: number;
  duplicates: number;
  rejected: { eventId: string | null; reason: PartnerRejectReason }[];
}

/** POST /vendor-links yanıtı: ortak cihazı kişiye bağlandı (üretici hesap kimliği şifreli saklanır, dönmez). */
export interface VendorLinkView {
  id: string;
  partner: string;
  model: string;
  deviceId: string;
  protectedPersonId: string;
  status: 'ACTIVE' | 'REVOKED';
  dataRegion: string;
  consentAt: string | null;
  consentBasis: 'EXPLICIT_CONSENT' | 'SCC_NOTIFIED' | 'ADEQUACY' | 'NOT_REQUIRED';
  createdAt: string;
}

/** GET /supervisor/partners: ortak başına son 1 saatin gecikmesi (S2.7, S7.2). */
export interface PartnerHealth {
  partner: string;
  samples: number;
  p95Ms: number | null;
  p99Ms: number | null;
  degradedSince: string | null;
  checkedAt: string | null;
}

/** Operasyon iş emri (S4.9): 12 ay pilli kolyenin pil değişimi (14 gün içinde yerinde). */
export interface WorkOrder {
  id: string;
  kind: 'PENDANT_BATTERY';
  status: 'OPEN' | 'DONE';
  reason: 'LOW_BATTERY' | 'PREDICTED_END';
  deviceId: string;
  protectedPersonId: string;
  batteryPct: number | null;
  predictedEndAt: string | null;
  dueAt: string;
  createdAt: string;
  closedAt: string | null;
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
  /** Olay kimliği; T-085 OEM ortak uyarısında (O-OEM-LATENCY) `partner:<kod>`. */
  eventId: string;
  /** Olay türü; ortak uyarısında PARTNER (konsol O-TYPE-PARTNER). */
  eventType: EventType | 'PARTNER';
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

// ---- T-092 değer kuralları (docs/07 S6) ve BLE köprülü cihazlar (S2.1 B sınıfı, S4.8, S7.5) ----
/** Ölçüm kalite sınıfı (S1.4): Q1 doğrulanmış, Q2 bilek optik, Q3 yüzük/kulak/küpe sağlık-amaçlı. */
export type VitalQuality = 'Q1' | 'Q2' | 'Q3';
/** Ölçüm anındaki bağlam (cihaz biliyorsa); yoksa sunucu uyku penceresi ve adımdan türetir. */
export type VitalContext = 'RESTING' | 'ACTIVE' | 'SLEEP';
export interface VitalMeta {
  quality?: VitalQuality;
  context?: VitalContext;
}
/** Taban çizgisi dilimi (S6.3). */
export type VitalSlice = 'SLEEP' | 'REST' | 'ACTIVE';
/**
 * Değer kuralları (S6.4): LOW_HR_STILL düşük nabız + hiçbir cihazda hareket yok (P2); LOW_HR, HIGH_HR (P3);
 * HR_BASELINE_DEVIATION (yalnız aileye P4 eğilim); SPO2_LOW (P3) / SPO2_LOW_HR (P2); FALL_HR_HIGHLIGHT düşme
 * olayında operatöre vurgu (P1 kalır).
 */
export type VitalRule =
  'LOW_HR_STILL' | 'LOW_HR' | 'HIGH_HR' | 'HR_BASELINE_DEVIATION' | 'SPO2_LOW' | 'SPO2_LOW_HR' | 'FALL_HR_HIGHLIGHT';

/** GET /events/{id}/vitals — yalnız açık olayda; 5 dk'lık ortancalar (dakika düzeyinde ham veri yok). */
export interface EventVitalsView {
  eventId: string;
  windowMin: number;
  bucketMin: number;
  series: { kind: 'HR' | 'SPO2'; points: { at: string; value: number; n: number }[] }[];
  /** Kişisel taban çizgisi (dilim ortancaları); oluşmadıysa null (genel eşikler). */
  baseline: { HR: Partial<Record<VitalSlice, number>> } | null;
  /** Penceredeki en iyi etkin kalite (iki cihaz uyuşursa bir basamak güçlü); örnek yoksa null. */
  quality: VitalQuality | null;
  /** Olayı açan / olaya eklenen değer kuralı ve okuma; vurgu (düşme + alışılmadık nabız) dahil. */
  alerts: { rule: VitalRule; value: number; at: string }[];
  highlight: boolean;
  /** Konsolun gösterdiği sağlık-amaçlı uyarı notu (katalog kodu). */
  noteCode: string;
}

/** GET /protected-persons/{id}/trends/weekly — aile; haftalık özet (ham veri yok). */
export interface WeeklyTrendsView {
  protectedPersonId: string;
  /** Sağlık-amaçlı uyarı notu (katalog kodu, aile uygulaması gösterir). */
  noteCode: string;
  weeks: {
    weekStart: string;
    restingHr: number | null;
    sleepHr: number | null;
    spo2: number | null;
    /** Cilt sıcaklığı sapması eşiği (+1,0 °C) aşılan gece sayısı ve iki gece üst üste aşıldı mı (S6.4). */
    skinTempNightsAbove: number;
    skinTempTwoNights: boolean;
    validDays: number;
  }[];
  /** "İyi" olmayan değer olayı sonuçları (S6.8). */
  outcomes: { eventId: string; type: EventType; outcome: string; at: string }[];
}

/** GET|PUT /protected-persons/{id}/vital-settings (S6.7). Eşik null → genel eşik (`defaults`). */
export interface VitalSettings {
  /** Değer kuralları açık mı; kapalıyken PUT 404. */
  enabled: boolean;
  lowHr: number | null;
  highHr: number | null;
  spo2Low: number | null;
  copd: boolean;
  trendsMuted: boolean;
  familyConsentAt: string | null;
  doctorNote: boolean;
  learningUntil: string | null;
  defaults: { lowHr: number; highHr: number; spo2Low: number; spo2LowCopd: number };
}

/** GET /supervisor/vital-reviews (S6.7): amirin eşik incelemesi kuyruğu; değer yok. */
export interface VitalReview {
  id: string;
  protectedPersonId: string;
  name: string | null;
  rule: VitalRule;
  /** WEEKLY_LIMIT: haftalık kontrol araması sınırı aşıldı; FALSE_ALARMS: değerlerde tekrarlayan yanlış alarm. */
  reason: 'WEEKLY_LIMIT' | 'FALSE_ALARMS';
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** T-092 telefon köprüsüyle bağlanan BLE cihaz modelleri (S2.1, S7.5). */
export type BridgedDeviceModel = 'BLE_HR' | 'BLE_PULSE_OX' | 'BLE_THERMO' | 'BLE_PENDANT';
/** POST /devices/bridged yanıtı ve GET /devices/bridged öğesi. */
export interface BridgedDeviceView {
  deviceId: string;
  model: BridgedDeviceModel;
  category: DeviceCategory;
  tier: DeviceTier;
  /** Telefonun bu cihaz için gönderebileceği sinyal türleri (model profili). */
  signals: SignalKind[];
  bridgeDeviceId: string;
  nickname: string | null;
  createdAt: string;
}

// ---- T-081 (ASVS 8.3.2, KVKK m.11) kişisel veri dışa aktarma: GET /family/data-export ----

/**
 * Dışa aktarmada bilerek verilmeyenler (docs/security/saklama.md "Dışa aktarma"): tıbbi özet içeriği (yalnız olay
 * anında operatöre çözülür), rehber numarasının tamamı (aile ekranı son 2 hane), değer (health) verisi, görüşme
 * kaydı, denetim kaydı, operatör notları ve kimlikleri, ham konum geçmişi. Kodlar makine içindir; metin yok.
 */
export type DataExportWithheld =
  | 'MEDICAL_CONTENT'
  | 'CONTACT_PHONE_FULL'
  | 'HEALTH_VITALS'
  | 'CALL_RECORDINGS'
  | 'AUDIT_LOG'
  | 'OPERATOR_DATA'
  | 'LOCATION_HISTORY';

/** GET /protected-persons/{id} ile aynı alanlar (aileye görünen profil). */
export interface DataExportProfile {
  id: string;
  displayName: string;
  birthYear: number | null;
  language: string;
  timezone: string;
  status: string;
  learningModeUntil: string | null;
  address: {
    line: string;
    district: string | null;
    city: string;
    postalCode: string | null;
    lat: number | null;
    lng: number | null;
  } | null;
  doorAccessNote: string | null;
  myRole: 'OWNER' | 'MEMBER' | null;
  dailySummary: boolean;
  locationSharing: boolean;
  hearingSpeechImpaired: boolean;
  holdMode: { kind: 'HOSPITAL' | 'TRAVEL'; until: string } | null;
  coverageToleranceMin: number;
  /** Yalnız var/yok ve rıza zamanı; içerik dışa aktarılmaz (MEDICAL_CONTENT). */
  medical: { present: boolean; consentAt: string | null; updatedAt: string | null };
  createdAt: string;
}

export interface DataExportPerson {
  profile: DataExportProfile;
  /** GET /protected-persons/{id}/members ile aynı (başka üyenin kimliği yok). */
  members: { id: string; role: 'OWNER' | 'MEMBER'; relation: string | null; createdAt: string; isMe: boolean }[];
  /** GET /protected-persons/{id}/contacts ile aynı (numaranın son 2 hanesi). */
  contacts: {
    id: string;
    role: 'ELDER' | 'WATCH' | 'CONTACT' | 'NEIGHBOR';
    priority: number;
    displayName: string | null;
    phoneLast2: string;
    hasKey: boolean;
    arrivalMin: number | null;
    reachableHours: string | null;
  }[];
  /** Push token'ı ve cihaz numarası yok. */
  devices: {
    id: string;
    kind: string;
    modelId: string | null;
    category: string | null;
    tier: string | null;
    nickname: string | null;
    bodyLocation: string | null;
    osVersion: string | null;
    appVersion: string | null;
    enrolledAt: string | null;
    lastSeenAt: string | null;
    revokedAt: string | null;
    retiredAt: string | null;
  }[];
  /** Olay özeti (en yeni önce, en çok 1000): konum, operatör ve notlar yok. */
  events: {
    id: string;
    type: string;
    priority: number;
    isTest: boolean;
    state: string;
    createdAt: string;
    closedAt: string | null;
    outcome: string | null;
  }[];
  /** Günlük özet (saklama süresi içindeki günler). */
  dailySummaries: {
    day: string;
    steps: number | null;
    hrMin: number | null;
    hrAvg: number | null;
    hrMax: number | null;
    wristMinutes: number;
  }[];
  subscriptions: {
    plan: string;
    status: string;
    countryCode: string;
    startedAt: string;
    trialEndsAt: string | null;
    renewsAt: string | null;
    canceledAt: string | null;
  }[];
  consents: {
    /** Abonelik başına KVKK aydınlatma sürümü ve açık rıza zamanı. */
    kvkk: { noticeVersion: string | null; explicitConsentAt: string | null }[];
    /** Tıbbi özet rızası (özet silinince rıza kaydı da kalkar). */
    medicalConsentAt: string | null;
    /** Üretici bulutu bağlantıları: aktarım dayanağı ve bölge (hesap kimliği yok). */
    vendorLinks: {
      partner: string;
      dataRegion: string;
      consentBasis: string;
      consentAt: string | null;
      createdAt: string;
      revokedAt: string | null;
    }[];
  };
}

export interface DataExport {
  format: 'yanimda.data-export.v1';
  generatedAt: string;
  account: {
    /** consumers realm `sub`. Ad, e-posta, telefon DB'de değil, Keycloak'ta (hesap konsolunda görülür). */
    subject: string;
    memberships: { protectedPersonId: string; role: 'OWNER' | 'MEMBER'; relation: string | null; since: string }[];
    pushTargets: { platform: string; updatedAt: string }[];
    memberInvitesCreated: { protectedPersonId: string; createdAt: string; expiresAt: string; usedAt: string | null }[];
    feedback: { eventId: string; real: boolean; at: string }[];
    /** Bu hesabın push hedeflerine giden bildirimler (en yeni önce, en çok 1000): kod, metin yok. */
    notifications: {
      code: string;
      channel: string;
      status: string;
      protectedPersonId: string;
      eventId: string | null;
      createdAt: string;
      deliveredAt: string | null;
    }[];
  };
  persons: DataExportPerson[];
  withheld: DataExportWithheld[];
}
