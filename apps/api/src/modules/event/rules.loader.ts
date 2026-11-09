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
}
export interface RulePack {
  country: string;
  version: number;
  rules: Rule[];
}

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
