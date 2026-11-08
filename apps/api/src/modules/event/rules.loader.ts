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
}
export interface RulePack {
  country: string;
  version: number;
  rules: Rule[];
}

/** D-02: kural paketi YAML'dan yüklenir; T-012'de sıcak yükleme ve JSON Schema doğrulaması eklenir. */
export function loadRulePack(country = process.env.COUNTRY_CODE ?? 'TR'): RulePack {
  const p = join(__dirname, `../../../../../packages/rules/${country.toLowerCase()}.yaml`);
  const pack = YAML.parse(readFileSync(p, 'utf8')) as RulePack;
  return pack;
}
export const ruleFor = (pack: RulePack, type: EventType) => pack.rules.find((r) => r.type === type);
