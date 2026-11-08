import type { ProtectionState } from '@yanimda/contracts';

import { NO_CONNECTION_MIN } from './decide';
import { isInWindow } from './night';

/**
 * D-05 koruma durumu (T-014). Saf kural: son bilinen olgular + an + kişinin gece penceresi → durum.
 *   saat bağlı ve bilekte            → PROTECTED_WATCH (gece de)
 *   değilse, gece penceresindeyse    → NIGHT
 *   değilse, telefon bağlıysa        → PROTECTED_PHONE
 *   hiçbiri değilse                  → UNPROTECTED
 * "Bağlı" = son 15 dk içinde görüldü (NO_CONNECTION_MIN). Saat BLE ile geliyorsa telefon da görülmüştür (köprü).
 */
export interface ProtectionFacts {
  watchOnWrist: boolean | null;
  watchSeenAt: Date | null;
  phoneSeenAt: Date | null;
}

export interface SleepWindow {
  timezone: string;
  start: string;
  end: string;
}

export interface ProtectionResult {
  state: ProtectionState;
  reason: string;
}

const online = (seen: Date | null, now: Date) => !!seen && now.getTime() - seen.getTime() < NO_CONNECTION_MIN * 60_000;

export function computeProtection(f: ProtectionFacts, now: Date, w: SleepWindow): ProtectionResult {
  if (online(f.watchSeenAt, now) && f.watchOnWrist === true)
    return { state: 'PROTECTED_WATCH', reason: 'saat bilekte' };
  if (isInWindow(now, w.timezone, w.start, w.end)) return { state: 'NIGHT', reason: 'gece penceresi' };
  if (online(f.phoneSeenAt, now)) return { state: 'PROTECTED_PHONE', reason: 'telefon koruyor' };
  return { state: 'UNPROTECTED', reason: 'saat ve telefon bağlı değil' };
}
