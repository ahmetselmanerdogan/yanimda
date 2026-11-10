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
export interface RulePack {
  country: string;
  version: number;
  learning?: LearningParams;
  falseAlarm?: FalseAlarmParams;
  numbers?: OfficialNumbers;
  rules: Rule[];
}

/** Paket alan vermezse kullanılan değerler (tr.yaml ile aynı). */
export const DEFAULT_LEARNING: LearningParams = { days: 30, historyDays: 14, minDays: 7, inactivityPercentile: 95 };
export const DEFAULT_FALSE_ALARM: FalseAlarmParams = { windowDays: 30, reviewAfter: 3 };
export const learningOf = (pack: RulePack): LearningParams => pack.learning ?? DEFAULT_LEARNING;
export const falseAlarmOf = (pack: RulePack): FalseAlarmParams => pack.falseAlarm ?? DEFAULT_FALSE_ALARM;
export const DEFAULT_NUMBERS: OfficialNumbers = { emergency: '112', social: '183', health: '182' };
export const numbersOf = (pack: RulePack): OfficialNumbers => pack.numbers ?? DEFAULT_NUMBERS;

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
