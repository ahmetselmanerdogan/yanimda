/**
 * T-052 numara biçimi (E-05). Türkiye numaraları E.164'te `+90` + 10 hane: cep (5xx), coğrafi (2xx/3xx/4xx alan
 * kodu), 850 (coğrafi olmayan), 800 (ücretsiz). SIP trunk (Netgsm/Verimor) arayanı ulusal biçimde ve `sip:` URI
 * içinde verebilir; eşleştirmeden önce E.164'e çevrilir. Yurt dışı numaralar (yakınlar) yalnız E.164 olarak kabul.
 * Bu modül numarayı log'a yazmaz.
 */
export type TrNumberKind = 'MOBILE' | 'GEOGRAPHIC' | 'NON_GEOGRAPHIC' | 'TOLL_FREE';

const E164 = /^\+[1-9]\d{6,14}$/;

export function trNumberKind(e164: string): TrNumberKind | null {
  const m = /^\+90(\d{10})$/.exec(e164);
  if (!m) return null;
  const d = m[1]!;
  if (d.startsWith('5')) return 'MOBILE';
  if (d.startsWith('850')) return 'NON_GEOGRAPHIC';
  if (d.startsWith('800')) return 'TOLL_FREE';
  if (/^[234]/.test(d) && !d.startsWith('444')) return 'GEOGRAPHIC';
  return null;
}

/** Ulusal / uluslararası / `sip:` / `tel:` biçimini E.164'e çevirir; geçersizse null. Varsayılan ülke TR. */
export function normalizePhone(input: string | undefined | null): string | null {
  if (!input) return null;
  let s = input.trim();
  if (/^client:/i.test(s)) return null;
  s = s.replace(/^(sips?|tel):/i, '').replace(/[@;].*$/, '');
  s = s.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;
  let e: string;
  if (s.startsWith('+')) e = s;
  else if (s.startsWith('00')) e = `+${s.slice(2)}`;
  else if (s.startsWith('90') && s.length === 12) e = `+${s}`;
  else if (s.startsWith('0') && s.length === 11) e = `+90${s.slice(1)}`;
  else if (s.length === 10 && /^[2-8]/.test(s)) e = `+90${s}`;
  else return null;
  if (!E164.test(e)) return null;
  if (e.startsWith('+90') && !trNumberKind(e)) return null;
  return e;
}

/** Operatöre gösterim: `0532 123 45 67`; TR değilse E.164 olduğu gibi. */
export function formatTrNational(e164: string): string {
  if (!trNumberKind(e164)) return e164;
  const d = e164.slice(3);
  return `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`;
}

const NUMBER_VARS = [
  'TWILIO_FROM_NUMBER',
  'CPAAS_AGENT_NUMBER',
  'CPAAS_INBOUND_NUMBER',
  'CPAAS_BACKUP_NUMBER',
] as const;
const RANGES: [string, number, number][] = [
  ['INBOUND_RING_SEC', 5, 60],
  ['INBOUND_RETRY_SEC', 0, 600],
  ['INBOUND_WAIT_PAUSE_SEC', 1, 60],
];

/**
 * Başlangıç denetimi: telefoni numaraları E.164 olmalı (düzeltme önerilir), BYOC trunk kimliği `BY` + 32 hex,
 * süreler aralıkta. Ülke TR iken TR dışı numara uyarıdır (deneme hesabı ABD numarasıyla çalışabilir; kabul testleri
 * TR numarasından yapılmalı). Mesajlarda sır yok.
 */
export function telephonyEnvProblems(env: NodeJS.ProcessEnv = process.env): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tr = (env.COUNTRY_CODE ?? 'TR') === 'TR';
  for (const k of NUMBER_VARS) {
    const v = env[k];
    if (!v) continue;
    const n = normalizePhone(v);
    if (n !== v || !E164.test(v)) {
      errors.push(`${k}: E.164 biçiminde olmalı${n ? ` (ör. ${n})` : ''}`);
      continue;
    }
    if (tr && !v.startsWith('+90')) warnings.push(`${k}: TR numarası değil; kabul aramaları TR numarasından yapılmalı`);
  }
  const byoc = env.TWILIO_BYOC_TRUNK_SID;
  if (byoc && !/^BY[0-9a-f]{32}$/i.test(byoc)) errors.push('TWILIO_BYOC_TRUNK_SID: BY ile başlayan 34 karakter olmalı');
  for (const [k, min, max] of RANGES) {
    const v = env[k];
    if (v === undefined || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(`${k}: ${min}–${max} arası tam sayı olmalı`);
  }
  return { errors, warnings };
}
