import type { ChainStep, EventState, LadderView, StepResult } from '@yanimda/contracts';

import { has } from './i18n';

/**
 * T-087/T-088 (docs/07 S5, S3.3) olay ekranı merdiven yardımcıları — saf, test edilir.
 */

/** 112 son sınırı ekranda: kişiye/yakına ulaşılmamış olabilecek durumlarda (teyitli iyi, 112 arandı, kapalı hariç). */
const DEADLINE_STATES = new Set<EventState>([
  'OPERATOR_QUEUE',
  'OPERATOR_ASSIGNED',
  'CONTACT_CHAIN',
  'CONFIRMED_EMERGENCY',
]);

/** Kalan saniye (negatif = geçti); gösterilmeyecekse undefined. */
export function deadline112LeftSec(
  ladder: Pick<LadderView, 'call112DeadlineAt'> | undefined,
  state: EventState,
  now: number,
): number | undefined {
  if (!ladder?.call112DeadlineAt || !DEADLINE_STATES.has(state)) return undefined;
  return Math.floor((Date.parse(ladder.call112DeadlineAt) - now) / 1000);
}

/** Sonuç etiketi kodu: sistemin çevrimdışı atlaması katalogda O-RES-SKIPPED_OFFLINE. */
export const resultCode = (r: StepResult) => (r === 'OFFLINE_SKIPPED' ? 'O-RES-SKIPPED_OFFLINE' : `O-RES-${r}`);

/** Sistem atlama gerekçesi katalog koduysa (O-SKIP-*, O-RES-*) kod; operatörün serbest metni gösterilmez. */
export const systemReason = (reason: string | undefined) =>
  reason && /^O-[A-Z0-9_-]+$/.test(reason) && has(reason) ? reason : null;

/** "Bağlandı, ses yok" yalnız kişinin sesli cihaz adımında. */
export const isDeviceStep = (s: Pick<ChainStep, 'target'>) =>
  s.target === 'WATCH' || s.target === 'ELDER_PHONE' || s.target === 'VOICE_DEVICE';
