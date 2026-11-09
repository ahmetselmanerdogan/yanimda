import catalog from '@yanimda/messages/tr.json';

interface Message {
  channel: string;
  text: string;
  action?: string;
}
const messages = catalog as Record<string, Message>;

/** Katalog metni (02 "Mesaj kataloğu"). Eksik değişken "bilinmiyor" olur (T-024: boş alan "bilinmiyor"). */
export function t(code: string, vars: Record<string, string | number | null | undefined> = {}): string {
  const m = messages[code];
  if (!m) {
    console.warn(`Mesaj kataloğunda yok: ${code}`);
    return code;
  }
  return m.text.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null || v === '' ? (messages['O-UI-UNKNOWN']?.text ?? '?') : String(v);
  });
}

/** Katalog kaydının düğme metni (action). */
export function action(code: string): string {
  return messages[code]?.action ?? t(code);
}

export const has = (code: string) => code in messages;
