import type { Rule } from './rules.loader';

/**
 * Olayın operatör adım şablonu (D-03). Test olayları (isTest) 112 adımı olmadan şablon alır: test SOS'u
 * kurulum görüşmesidir, acil servise gidilmez (C-05). Zincir yürütücüsü T-021'de bunu kullanır.
 */
export function procedureFor(rule: Rule, isTest: boolean): string[] {
  return isTest ? rule.chain.filter((step) => step !== 'CALL_112') : [...rule.chain];
}
