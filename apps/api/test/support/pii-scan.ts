/**
 * T-081 PII denetimi: log metninde kişisel / sağlık verisi kalıbı arar. Bulgu değeri asla geri yazılmaz (maskeli).
 * Kullanım: birim test (pii-logs.spec.ts) ve CI'da uçtan uca log'ları (test/e2e/pii-audit-cli.ts).
 *
 * Kalıplar src/common/pii.ts'tedir (audit maskelemesiyle ortak). Bilinçli olarak geniş tutuldu; yanlış pozitif
 * olursa log satırı düzeltilir (ör. kimlik yerine ad yazılmış olabilir), kalıp gevşetilmez. İzin verilenler: UUID / uuidv7 olay kimlikleri, ISO zaman, HTTP durum kodları.
 */
import { PII_PATTERNS, type PiiPatternKind, validTckn } from '../../src/common/pii';

export { validTckn };

export type PiiKind = PiiPatternKind | 'literal';

export interface PiiFinding {
  kind: PiiKind;
  line: number;
  /** Maskeli örnek (ilk 2 karakter + uzunluk); asıl değer yazılmaz. */
  sample: string;
}

const mask = (v: string) => `${v.slice(0, 2)}…(${v.length})`;
// UUID'ler ve ISO zaman damgaları rakam dizisi içerir: taramadan önce nötrle
const NEUTRAL = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
  /\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}\s?[AP]M/g, // Nest konsol zaman damgası
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;]*m/g, // ANSI renk
];

export function scanPii(text: string, literals: string[] = []): PiiFinding[] {
  const out: PiiFinding[] = [];
  const lits = literals.filter((l) => l.trim().length >= 4).map((l) => l.toLocaleLowerCase('tr'));
  text.split('\n').forEach((raw, i) => {
    let line = raw;
    for (const n of NEUTRAL) line = line.replace(n, ' ');
    for (const [kind, rx] of PII_PATTERNS) {
      for (const m of line.matchAll(rx)) {
        if (kind === 'tckn' && !validTckn(m[0])) continue;
        out.push({ kind, line: i + 1, sample: mask(m[0]) });
      }
    }
    const lower = line.toLocaleLowerCase('tr');
    for (const l of lits) if (lower.includes(l)) out.push({ kind: 'literal', line: i + 1, sample: mask(l) });
  });
  return out;
}
