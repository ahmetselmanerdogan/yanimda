import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EventType } from '@yanimda/contracts';
import YAML from 'yaml';

export interface Rule {
  type: EventType;
  priority: 1 | 2 | 3 | 4;
  devicePrompt?: { enabled: boolean; windowSec?: number; repeatVibrateSec?: number; silent?: boolean; tts?: string };
  chain: string[];
  stepTimeoutSec?: Record<string, number>;
  silenceIsEmergencySec?: number;
  followUpAfterHours?: number;
  thresholdMin?: { default: number; learnable?: boolean; min?: number; max?: number };
  suppressIn?: string[];
  remindAfterMin?: number;
  operatorAfterMin?: number;
  afterHours?: number;
  /** Kişi/yakın aramalarında operatör metni (112 hariç), ör. TEST → O-SCRIPT-TEST (T-063). */
  operatorScript?: string;
  /** D-06: öğrenme modunda operatöre düşmeden önce ek sessiz soru (yalnız sessiz soru olan kurallar). */
  learningMode?: { extraSilentAsks?: number };
  /** D-12 (T-072): soru/bekleme cevapsızsa operatörden önce kişiye sesli arama. Asla SOS/FALL. */
  autoVoiceScreening?: AutoVoiceScreening;
}
export interface AutoVoiceScreening {
  enabled: boolean;
  /** Soru metni (katalog kodu, voice kanalı). */
  phrase: string;
  acceptIf: string[];
  helpIf?: string[];
  acceptDigits?: string[];
  minConfidence?: number;
  timeoutSec?: number;
  /** Öğrenme modunda (ilk ay) OK sonuçlarının operatöre CALLBACK olarak düşen oranı. */
  operatorSampleRate?: number;
}
/** D-06 öğrenme modu parametreleri (T-070). */
export interface LearningParams {
  days: number;
  historyDays: number;
  minDays: number;
  inactivityPercentile: number;
}
/** D-07 yanlış alarm parametreleri (T-071). */
export interface FalseAlarmParams {
  windowDays: number;
  reviewAfter: number;
}
/** T-052 resmi hatlar: acil (112), sosyal destek (183), sağlık (182). Operatör bunları masa sabit hattından arar. */
export interface OfficialNumbers {
  emergency: string;
  social: string;
  health: string;
}
/** docs/07 S5 (T-087) ulaşılamama merdiveni. */
export interface LadderParams {
  /** P1 sesli cihaz otomatik cevap süresi (sn); yanınızdayız aramasında asla. */
  autoAnswerSec: number;
  /** Kuyrukta üstlenilmeyen P1 → amir çağrılır (O-P1-UNCLAIMED). */
  unclaimedSupervisorSec: number;
  /** S5.3 (sahip kararı): üstlenilmeyen P1'de 1. yakına sesli mesaj. Varsayılan kapalı. */
  unclaimedVoiceContact: { enabled: boolean; afterSec: number; phrase: string };
  /** S5.5: evden bu kadar uzaktaysa komşu ve anahtar sahibi atlanır. */
  awayFromHomeM: number;
  /** T-089 (S7.1): operatörün "Soru gönder" komutu — olay türünün cihaz sorusu yoksa bu metin ve süre. */
  operatorPrompt: { windowSec: number; tts: string };
}
/** docs/07 S3.3–S3.7 (T-088) sinyal birleştirme. */
export interface FusionParams {
  corroborateSec: number;
  corroboratedPromptSec: number;
  crossCancelFollowUp: boolean;
  crossCancelFollowUpMin: number;
  gpsFreshSec: number;
}
/** T-085 (S3.2): cihaz bu kadar dk görülmezse çevrimdışı (sınıfa göre). */
export interface CoverageParams {
  onlineMin: { A: number; B: number };
  locationStaleMin?: number;
}
/** T-086 (S4.2, S4.6): pil eşikleri (%) ve planlı şarj kontrol saati (kişinin saat diliminde, HH:MM). */
export interface BatteryParams {
  warnPct: number;
  planPct: number;
  familyPct: number;
  criticalPct: number;
  deadPct: number;
  planHour: string;
}
/** T-086 (S4.3–S4.5): şarj penceresi ve şarj boşluğu zamanlayıcıları (dk; uyanık süre). */
export interface ChargingParams {
  defaultWindow: string;
  chargeDonePct: number;
  chargeDoneMin: number;
  putOnMin: number[];
  familyGapMin: number;
  familyGapOffPlanMin: number;
  maxGapMin: number;
  intentMin: number;
  /** Gece penceresi bittikten sonra zamanlayıcıların yeniden işlemeye başladığı süre (uyanış + 30 dk). */
  resumeAfterWakeMin?: number;
  /** S4.3 öğrenilmiş şarj penceresi (T-086, 0035). */
  learn?: Partial<ChargeLearnParams>;
}
/**
 * S4.3: son `days` günün CHARGE_START / CHARGE_END geçmişinden günün ana şarjı (en uzun oturum, ≥ minSessionMin,
 * ≤ maxSessionH) bulunur; en az `minDays` geçerli gün varsa başlangıç ve bitişin ortancası `roundMin`'e yuvarlanarak
 * pencere olur (LEARNED). Aile elle verdiyse (FAMILY) dokunulmaz; gece penceresine taşan pencere öğrenilmez.
 */
export interface ChargeLearnParams {
  days: number;
  minDays: number;
  minSessionMin: number;
  maxSessionH: number;
  roundMin: number;
}
/**
 * S4.10 kronik boşluk: `days` günde `gaps` kapsama boşluğundan sonra her boşlukta P3 açılmaz; aileye bir kez plan
 * bildirimi (F-COVERAGE-CHRONIC), operasyona bir takip (FOLLOW_UP). Kişiye özel tolerans (dk) olay eşiğine eklenir
 * (en çok toleranceMaxMin). S7.2 amir listesi: son 7 günde uyanık zamanın protectedPct'sinden azı korunanlar.
 */
export interface ChronicGapParams {
  gaps: number;
  days: number;
  toleranceMaxMin: number;
  protectedPct: number;
}
/**
 * T-086 (S4.7): hiçbir SOS yolu yokken (uyanık) dk — remindMin'de hatırlatma + yaşlıya otomatik sesli arama.
 * T-087 YERİNDE KONTROL (P2) saatleri: welfareDroppedH takılı cihaz birden sustu, welfareSilentH tüm cihazlar sessiz
 * (ikisi de uyanık süre), welfareNoMovementH yanınızdayız araması cevapsız + hareket yok (S5.4).
 */
export interface CoverageNoneParams {
  remindMin: number;
  familyMin: number;
  eventMin: number;
  welfareSilentH: number;
  welfareDroppedH: number;
  welfareNoMovementH: number;
}
export interface RulePack {
  country: string;
  version: number;
  learning?: LearningParams;
  falseAlarm?: FalseAlarmParams;
  numbers?: OfficialNumbers;
  /** T-087: kuyruğa düşüşten 112 son sınırı (sn), olay türüne göre. */
  call112DeadlineSec?: Partial<Record<EventType, number>>;
  ladder?: Partial<LadderParams>;
  fusion?: Partial<FusionParams>;
  coverage?: CoverageParams;
  battery?: BatteryParams;
  charging?: ChargingParams;
  coverageNone?: Partial<CoverageNoneParams> & Pick<CoverageNoneParams, 'remindMin' | 'familyMin' | 'eventMin'>;
  chronicGap?: Partial<ChronicGapParams>;
  rules: Rule[];
}

/** Paket alan vermezse kullanılan değerler (tr.yaml ile aynı). */
export const DEFAULT_LEARNING: LearningParams = { days: 30, historyDays: 14, minDays: 7, inactivityPercentile: 95 };
export const DEFAULT_FALSE_ALARM: FalseAlarmParams = { windowDays: 30, reviewAfter: 3 };
export const learningOf = (pack: RulePack): LearningParams => pack.learning ?? DEFAULT_LEARNING;
export const falseAlarmOf = (pack: RulePack): FalseAlarmParams => pack.falseAlarm ?? DEFAULT_FALSE_ALARM;
export const DEFAULT_NUMBERS: OfficialNumbers = { emergency: '112', social: '183', health: '182' };
export const numbersOf = (pack: RulePack): OfficialNumbers => pack.numbers ?? DEFAULT_NUMBERS;
export const DEFAULT_LADDER: LadderParams = {
  autoAnswerSec: 10,
  unclaimedSupervisorSec: 90,
  unclaimedVoiceContact: { enabled: false, afterSec: 180, phrase: 'V-NO-OPERATOR' },
  awayFromHomeM: 200,
  operatorPrompt: { windowSec: 60, tts: 'W-OP-PROMPT' },
};
export const DEFAULT_FUSION: FusionParams = {
  corroborateSec: 90,
  corroboratedPromptSec: 30,
  crossCancelFollowUp: true,
  crossCancelFollowUpMin: 60,
  gpsFreshSec: 120,
};
export const ladderOf = (pack: RulePack): LadderParams => ({ ...DEFAULT_LADDER, ...pack.ladder });
export const fusionOf = (pack: RulePack): FusionParams => ({ ...DEFAULT_FUSION, ...pack.fusion });
/** T-087: olayın 112 son sınırı (sn); türün sınırı yoksa null. */
export const call112DeadlineSecOf = (pack: RulePack, type: EventType): number | null =>
  pack.call112DeadlineSec?.[type] ?? null;
export const DEFAULT_COVERAGE: CoverageParams = { onlineMin: { A: 15, B: 30 }, locationStaleMin: 30 };
export const DEFAULT_BATTERY: BatteryParams = {
  warnPct: 20,
  planPct: 30,
  familyPct: 15,
  criticalPct: 10,
  deadPct: 5,
  planHour: '18:00',
};
export const DEFAULT_CHARGING: ChargingParams = {
  defaultWindow: '19:00-21:00',
  chargeDonePct: 80,
  chargeDoneMin: 20,
  putOnMin: [15, 30],
  familyGapMin: 90,
  familyGapOffPlanMin: 60,
  maxGapMin: 120,
  intentMin: 90,
  resumeAfterWakeMin: 30,
};
export const DEFAULT_COVERAGE_NONE: CoverageNoneParams = {
  remindMin: 20,
  familyMin: 45,
  eventMin: 60,
  welfareSilentH: 6,
  welfareDroppedH: 2,
  welfareNoMovementH: 24,
};
export const DEFAULT_CHARGE_LEARN: ChargeLearnParams = {
  days: 14,
  minDays: 7,
  minSessionMin: 20,
  maxSessionH: 12,
  roundMin: 15,
};
export const DEFAULT_CHRONIC_GAP: ChronicGapParams = { gaps: 5, days: 7, toleranceMaxMin: 240, protectedPct: 80 };
export const chargeLearnOf = (pack: RulePack): ChargeLearnParams => ({
  ...DEFAULT_CHARGE_LEARN,
  ...pack.charging?.learn,
});
export const chronicGapOf = (pack: RulePack): ChronicGapParams => ({ ...DEFAULT_CHRONIC_GAP, ...pack.chronicGap });
export const coverageOf = (pack: RulePack): CoverageParams => pack.coverage ?? DEFAULT_COVERAGE;
export const batteryOf = (pack: RulePack): BatteryParams => pack.battery ?? DEFAULT_BATTERY;
export const chargingOf = (pack: RulePack): ChargingParams => pack.charging ?? DEFAULT_CHARGING;
export const coverageNoneOf = (pack: RulePack): CoverageNoneParams => ({
  ...DEFAULT_COVERAGE_NONE,
  ...pack.coverageNone,
});

/** Geçerli kural paketini veren kaynak. Üretimde RulesService (sıcak yükleme); testlerde sabit paket. */
export interface RulesProvider {
  current(): RulePack;
}
export const RULES = Symbol('RULES');

export const staticRules = (pack: RulePack): RulesProvider => ({ current: () => pack });

/** Doğrulamasız ham okuma (testler/araçlar). Uygulama RulesService üzerinden doğrulanmış paketi kullanır. */
export function loadRulePack(country = process.env.COUNTRY_CODE ?? 'TR'): RulePack {
  const p = join(__dirname, `../../../../../packages/rules/${country.toLowerCase()}.yaml`);
  return YAML.parse(readFileSync(p, 'utf8')) as RulePack;
}
export const ruleFor = (pack: RulePack, type: EventType) => pack.rules.find((r) => r.type === type);
