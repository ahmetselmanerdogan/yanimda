import tokens from '@yanimda/ui-tokens/tokens.json';

/** packages/ui-tokens → CSS değişkenleri (konsol koyu tema varsayılan). */
export function applyTheme(root: HTMLElement = document.documentElement) {
  const c = tokens.color;
  const vars: Record<string, string | number> = {
    '--bg': c.neutral.bgDark,
    '--text': c.neutral.textDark,
    '--safe': c.safe,
    '--help': c.help,
    '--attention': c.attention,
    '--brand': c.brand,
    '--p1': c.priority.p1,
    '--p2': c.priority.p2,
    '--p3': c.priority.p3,
    '--p4': c.priority.p4,
    '--font-body': `${tokens.typography.console.body}px`,
    '--font-table': `${tokens.typography.console.table}px`,
    '--font-card-title': `${tokens.typography.console.cardTitle}px`,
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, String(v));
}
