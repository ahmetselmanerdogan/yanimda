import tokens from '@yanimda/ui-tokens/tokens.json';

/** packages/ui-tokens → CSS değişkenleri (açık / koyu). */
export function themeCss(): string {
  const c = tokens.color;
  const fam = tokens.typography.family;
  return `:root{--brand:${c.brand};--safe:${c.safe};--help:${c.help};--attention:${c.attention};--bg:${c.neutral.bgLight};--text:${c.neutral.textLight};--body:${fam.body}px;--caption:${fam.caption}px;--touch:${tokens.touch.phoneMinDp}px}
@media (prefers-color-scheme: dark){:root{--bg:${c.neutral.bgDark};--text:${c.neutral.textDark}}}`;
}
