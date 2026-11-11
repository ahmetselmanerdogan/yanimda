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
  /** Aramadan önce: cihaz son bu kadar dakikada görülmediyse adım OFFLINE_SKIPPED. */
  offlineSkipMin: number;
  /** P1 sesli cihaz otomatik cevap süresi (sn); yanınızdayız aramasında asla. */
  autoAnswerSec: number;
  /** Kuyrukta üstlenilmeyen P1 → amir çağrılır (O-P1-UNCLAIMED). */
  unclaimedSupervisorSec: number;
  /** S5.3 (sahip kararı): üstlenilmeyen P1'de 1. yakına sesli mesaj. Varsayılan kapalı. */
  unclaimedVoiceContact: { enabled: boolean; afterSec: number; phrase: string };
  /** S5.5: evden bu kadar uzaktaysa komşu ve anahtar sahibi atlanır. */
  awayFromHomeM: number;
}
/** docs/07 S3.3–S3.7 (T-088) sinyal birleştirme. */
export interface FusionParams {
  corroborateSec: number;
  corroboratedPromptSec: number;
  crossCancelFollowUp: boolean;
  crossCancelFollowUpMin: number;
  gpsFreshSec: number;
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
  offlineSkipMin: 15,
  autoAnswerSec: 10,
  unclaimedSupervisorSec: 90,
  unclaimedVoiceContact: { enabled: false, afterSec: 180, phrase: 'V-NO-OPERATOR' },
  awayFromHomeM: 200,
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
