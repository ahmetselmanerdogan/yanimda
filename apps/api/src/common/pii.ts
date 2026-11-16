/**
 * Kişisel / sağlık verisi kalıpları (T-081). Tek kaynak: CI log denetimi (test/support/pii-scan.ts) ve kalıcı,
 * silinemeyen kayıtlara (audit.log) yazılan serbest metnin maskelenmesi (`redactPii`).
 *
 * Kalıplar bilinçli olarak geniş: yanlış pozitif kayıpsızdır (yalnız maskelenir), yanlış negatif kalıcı ihlaldir.
 */
export type PiiPatternKind =
  'phone' | 'tckn' | 'email' | 'jwt' | 'bearer' | 'iban' | 'address' | 'coordinates' | 'medical';

export const MEDICAL_TERMS = [
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

export const PII_PATTERNS: readonly (readonly [PiiPatternKind, RegExp])[] = [
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
  ['medical', new RegExp(`(?<![\\p{L}])(${MEDICAL_TERMS.join('|')})(?![\\p{L}])`, 'giu')],
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

export const PII_MASK = '[gizli]';

/** Serbest metindeki kişisel / sağlık verisini `[gizli]` ile değiştirir (audit gerekçeleri gibi silinemeyen alanlar). */
export function redactPii(text: string): string {
  let out = text;
  for (const [kind, rx] of PII_PATTERNS)
    out = out.replace(rx, (m) => (kind === 'tckn' && !validTckn(m) ? m : PII_MASK));
  return out;
}
