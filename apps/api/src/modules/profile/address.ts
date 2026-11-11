/**
 * T-089 (docs/07 S7.7) "aynı adreste ikinci kişi": adresler sunucuda normalleştirilerek karşılaştırılır. Türkçe küçük
 * harf, aksan / noktalama yok, yaygın kısaltmalar açık (mah. → mahallesi, cad. → caddesi, sok./sk. → sokak …), "no" ve
 * "kat" gibi dolgu sözcükleri atılır. Adres log'a yazılmaz; yalnız eşitlik için kullanılır.
 */
const ABBREVIATIONS: Record<string, string> = {
  mah: 'mahallesi',
  mh: 'mahallesi',
  mahalle: 'mahallesi',
  cad: 'caddesi',
  cd: 'caddesi',
  cadde: 'caddesi',
  sok: 'sokak',
  sk: 'sokak',
  sokagi: 'sokak',
  blv: 'bulvari',
  bulv: 'bulvari',
  bulvar: 'bulvari',
  apt: 'apartmani',
  ap: 'apartmani',
  apartman: 'apartmani',
  sit: 'sitesi',
  site: 'sitesi',
  d: 'daire',
};
const FILLER = new Set(['no', 'numara', 'kat', 'k']);

export function normalizeAddress(parts: (string | null | undefined)[]): string {
  const text = parts
    .filter((x): x is string => !!x && !!x.trim())
    .join(' ')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return text
    .split(' ')
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .filter((w) => !FILLER.has(w))
    .join(' ');
}
