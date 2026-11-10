/**
 * T-081 PII denetimi: log metninde kişisel / sağlık verisi kalıbı arar. Bulgu değeri asla geri yazılmaz (maskeli).
 * Kullanım: birim test (pii-logs.spec.ts) ve CI'da uçtan uca log'ları (test/e2e/pii-audit-cli.ts).
 *
 * Kalıplar bilinçli olarak geniş tutuldu; yanlış pozitif olursa log satırı düzeltilir (ör. kimlik yerine ad yazılmış
 * olabilir), kalıp gevşetilmez. İzin verilenler: UUID / uuidv7 olay kimlikleri, ISO zaman, HTTP durum kodları.
 */
export type PiiKind =
  'phone' | 'tckn' | 'email' | 'jwt' | 'bearer' | 'iban' | 'address' | 'coordinates' | 'medical' | 'literal';

export interface PiiFinding {
  kind: PiiKind;
  line: number;
  /** Maskeli örnek (ilk 2 karakter + uzunluk); asıl değer yazılmaz. */
  sample: string;
}

const MEDICAL = [
  'diyabet',
  'insülin',
  'insulin',
  'hipertansiyon',
  'tansiyon',
  'alzheimer',
  'demans',
  'parkinson',
  'epilepsi',
  'kalp yetmezliği',
  'kalp pili',
  'astım',
  'koah',
  'inme',
  'felç',
  'kanser',
  'diyaliz',
  'varfarin',
  'warfarin',
  'coumadin',
  'metformin',
  'penisilin',
  'aspirin',
  'kan grubu',
  'alerji',
  'allerji',
  'ilaç',
];

const RX: [PiiKind, RegExp][] = [
  // E.164 (+90 5xx …) ve yerel cep (05xx xxx xx xx); boşluk/tire ayraçlı
  ['phone', /(?<![\w.-])\+\d{1,3}[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2,4}(?![\w-])/g],
  ['phone', /(?<![\w.-])0?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?![\w-])/g],
  ['tckn', /(?<![\w.-])[1-9]\d{10}(?![\w-])/g],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ['iban', /\bTR\d{2}\s?(?:\d{4}\s?){5}\d{2}\b/g],
  [
    'address',
    /(?<![\p{L}])(mahallesi|mah\.|sokak|sokağı|sok\.|caddesi|cad\.|cd\.|bulvarı|blv\.|apt\.|apartmanı|daire\s*\d|kapı\s*(?:no|kodu)|no:\s*\d)/giu,
  ],
  // hassas konum: 4+ ondalık enlem, boylam (≈ 10 m)
  ['coordinates', /(?<![\d.])-?\d{1,2}\.\d{4,}\s*[,;/ ]\s*-?\d{1,3}\.\d{4,}(?![\d])/g],
  ['medical', new RegExp(`(?<![\\p{L}])(${MEDICAL.join('|')})(?![\\p{L}])`, 'giu')],
];

/** TC kimlik no sağlama (yanlış pozitifi azaltır: rastgele 11 hane çoğunlukla geçmez). */
export function validTckn(s: string) {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  const d11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return d[9] === d10 && d[10] === d11;
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
    for (const [kind, rx] of RX) {
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
