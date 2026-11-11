import type { ProtectionState } from '@yanimda/contracts';

import { computeCoverage, DEFAULT_CAPS, type Facts, toProtectionState } from './coverage';
import { isInWindow } from './night';
import { batteryOf, coverageOf, type RulePack } from './rules.loader';

/**
 * D-05 koruma durumu (T-014) — T-085'ten beri kapsama seviyesinden TÜRETİLİR (docs/07 S3.1, bir sürüm boyunca):
 *   FULL / BASIC → PROTECTED_WATCH, PHONE_ONLY → PROTECTED_PHONE, NIGHT → NIGHT, NONE → UNPROTECTED.
 * Bu dosya yalnız tek saat + tek telefon olgularıyla çalışan eski saf kuralı korur (uyum testi); gerçek hesap çoklu
 * cihaz olgularıyla coverage.ts'tedir.
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

export const PROTECTION_REASON: Record<ProtectionState, string> = {
  PROTECTED_WATCH: 'alarm cihazı takılı',
  NIGHT: 'gece penceresi',
  PROTECTED_PHONE: 'telefon koruyor',
  UNPROTECTED: 'hiçbir SOS yolu yok',
};

/** Tek saat (A sınıfı, köprüsüz) + telefon olguları → kapsama → eski durum. */
export function computeProtection(
  f: ProtectionFacts,
  now: Date,
  w: SleepWindow,
  pack?: Pick<RulePack, 'coverage' | 'battery'>,
): ProtectionResult {
  const facts: Facts = {
    devices: f.watchSeenAt
      ? {
          watch: {
            id: 'watch',
            category: 'WATCH',
            tier: 'A',
            caps: DEFAULT_CAPS.WATCH,
            batteryLifeH: null,
            seenAt: f.watchSeenAt.toISOString(),
            onBody: f.watchOnWrist,
            charging: false,
            chargingSince: null,
            chargeEndedAt: null,
            batteryPct: null,
            bridged: false,
          },
        }
      : {},
    bridgeSeenAt: f.phoneSeenAt?.toISOString() ?? null,
  };
  const p = { coverage: undefined, battery: undefined, ...pack } as RulePack;
  const cov = computeCoverage(facts, now, {
    params: coverageOf(p),
    deadPct: batteryOf(p).deadPct,
    night: isInWindow(now, w.timezone, w.start, w.end),
  });
  const state = toProtectionState(cov.level);
  return { state, reason: PROTECTION_REASON[state] };
}
