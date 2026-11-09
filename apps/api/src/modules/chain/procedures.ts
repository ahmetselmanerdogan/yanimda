import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChainStep, StepTarget } from '@yanimda/contracts';
import YAML from 'yaml';

import { procedureFor } from '../event/procedure';
import type { Rule } from '../event/rules.loader';
import { RULES_DIR } from '../rules/rules.service';

/** packages/rules/procedures.<ülke>.yaml (doğrulaması packages/rules/validate.mjs'te, CI'da). */
export interface StepKind {
  label: string;
  script?: string;
  target: StepTarget;
  required: boolean;
  defaultTimeoutSec: number;
}
export interface ProcedurePack {
  country: string;
  version: number;
  steps: Record<string, StepKind>;
}

export function loadProcedures(country = process.env.COUNTRY_CODE ?? 'TR', dir = RULES_DIR): ProcedurePack {
  return YAML.parse(readFileSync(join(dir, `procedures.${country.toLowerCase()}.yaml`), 'utf8')) as ProcedurePack;
}

/**
 * D-03 olay tipinin adım listesi: sıra ve süreler kural paketinden (chain, stepTimeoutSec), etiket/metin/hedef
 * prosedür paketinden. `CALL_CONTACT:2` → 2. yakın. Test olayında 112 adımı yoktur (procedureFor).
 */
export function buildSteps(rule: Rule, isTest: boolean, proc: ProcedurePack): ChainStep[] {
  return procedureFor(rule, isTest).map((entry, i) => stepOf(entry, i + 1, rule, proc));
}

export function stepOf(entry: string, n: number, rule: Rule | undefined, proc: ProcedurePack): ChainStep {
  const [kind, idx] = entry.split(':') as [string, string | undefined];
  const k = proc.steps[kind];
  if (!k) throw new Error(`Prosedürde adım türü yok: ${kind}`);
  return {
    n,
    kind,
    target: k.target,
    ...(idx ? { contactIndex: Number(idx) } : {}),
    label: k.label,
    ...(k.script
      ? { script: k.script && rule?.operatorScript && k.target !== 'EMERGENCY' ? rule.operatorScript : k.script }
      : {}),
    timeoutSec: rule?.stepTimeoutSec?.[kind] ?? k.defaultTimeoutSec,
    required: k.required,
  };
}
