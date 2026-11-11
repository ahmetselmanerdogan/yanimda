import type { StepResult } from '@yanimda/contracts';

/** Klavye kısayolları (E-10). Saf eşleme; test edilir. */
export type Mode = 'normal' | 'assess' | 'skip' | 'close' | 'escalate' | 'note';
export type Command =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'claim' }
  | { kind: 'call' }
  | { kind: 'result'; result: Exclude<StepResult, 'SKIPPED'> }
  | { kind: 'skip' }
  | { kind: 'assess'; assessment: 'OK' | 'EMERGENCY' | 'CONTINUE' }
  | { kind: 'note' }
  | { kind: 'close' }
  | { kind: 'escalate' }
  | { kind: 'escape' };

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Odak metin alanında mı (textarea/input/select)? */
  editing: boolean;
}

const RESULTS: Record<string, Exclude<StepResult, 'SKIPPED' | 'REACHED'>> = {
  '2': 'NO_ANSWER',
  '3': 'BUSY',
  '4': 'WRONG_NUMBER',
  // T-087: otomatik cevaplı cihaz araması sessiz (olası acil durum)
  '6': 'SILENT',
};

export function commandFor(e: KeyInput, mode: Mode): Command | null {
  if (e.key === 'Escape') return { kind: 'escape' };
  if ((e.ctrlKey || e.metaKey) && e.key === '1') return { kind: 'escalate' };
  if (e.editing || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (mode === 'assess') {
    if (e.key === '1') return { kind: 'assess', assessment: 'OK' };
    if (e.key === '2') return { kind: 'assess', assessment: 'EMERGENCY' };
    if (e.key === '3') return { kind: 'assess', assessment: 'CONTINUE' };
    return null;
  }
  if (mode !== 'normal') return null;
  switch (e.key) {
    case 'ArrowUp':
      return { kind: 'up' };
    case 'ArrowDown':
      return { kind: 'down' };
    case 'Enter':
      return { kind: 'claim' };
    case 'a':
    case 'A':
      return { kind: 'call' };
    case '1':
      return { kind: 'result', result: 'REACHED' };
    case '5':
      return { kind: 'skip' };
    case 'n':
    case 'N':
      return { kind: 'note' };
    case 'c':
    case 'C':
      return { kind: 'close' };
  }
  const r = RESULTS[e.key];
  return r ? { kind: 'result', result: r } : null;
}
