import catalog from '@yanimda/messages/tr.json';

interface Message {
  channel: string;
  text: string;
  action?: string;
}
const messages = catalog as Record<string, Message>;

/** Katalog metni (packages/messages). Web'de uydurma metin yok: her görünen metin buradan. */
export function t(code: string, vars: Record<string, string | number> = {}): string {
  const m = messages[code];
  if (!m) {
    console.warn(`Mesaj kataloğunda yok: ${code}`);
    return code;
  }
  return m.text.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export const has = (code: string) => code in messages;
