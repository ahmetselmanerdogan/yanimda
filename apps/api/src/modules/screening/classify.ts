import type { ScreeningResult } from '../event/voice-screening';

/** Kural paketinden ön eleme eşleştirme ayarları (satırda anlık görüntü olarak saklanır). */
export interface ScreeningConfig {
  acceptIf: string[];
  helpIf?: string[];
  acceptDigits?: string[];
  minConfidence?: number;
}

const lower = (s: string) => s.toLocaleLowerCase('tr-TR');
/** Harf/rakam dışı → boşluk; kelime başı eşleşmesi için iki uca boşluk. */
const words = (s: string) =>
  ` ${lower(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
const firstMatch = (text: string, terms: string[] = []) => terms.find((t) => text.includes(` ${lower(t)}`)) ?? null;

/**
 * D-12 ön eleme cevabı (Twilio Gather: `Digits`, `SpeechResult`, `Confidence`):
 *  - tuş: kabul tuşu (1) → OK, başka tuş → UNCLEAR
 *  - konuşma: yardım terimi (hayır, yardım, değil …) → HELP (güvenden bağımsız, önce bakılır); kabul terimi
 *    (evet, iyiyim) ve güven ≥ minConfidence → OK; diğer → UNCLEAR. Eşleşme kelime başında ("nevet" değil).
 *  - hiçbiri → NO_ANSWER
 * Şüphede operatör: OK yalnız açık kabulde.
 */
export function classifyScreening(p: Record<string, string>, cfg: ScreeningConfig): ScreeningResult {
  const digits = p.Digits?.trim();
  if (digits) {
    const ok = (cfg.acceptDigits ?? ['1']).includes(digits);
    return { status: ok ? 'OK' : 'UNCLEAR', input: 'DTMF', matched: ok ? digits : null, confidence: null };
  }
  const speech = p.SpeechResult?.trim();
  if (!speech) return { status: 'NO_ANSWER', input: null, matched: null, confidence: null };
  const c = Number(p.Confidence);
  const confidence = p.Confidence !== undefined && Number.isFinite(c) ? c : null;
  const text = words(speech);
  const help = firstMatch(text, cfg.helpIf);
  if (help) return { status: 'HELP', input: 'SPEECH', matched: help, confidence };
  const ok = firstMatch(text, cfg.acceptIf);
  if (ok && (confidence === null || confidence >= (cfg.minConfidence ?? 0)))
    return { status: 'OK', input: 'SPEECH', matched: ok, confidence };
  return { status: 'UNCLEAR', input: 'SPEECH', matched: null, confidence };
}
