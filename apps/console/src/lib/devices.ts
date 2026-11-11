import type { CoverageLevel, CoverageReason, DeviceCategory, DeviceSummary } from '@yanimda/contracts';

import { has, t } from './i18n';

/**
 * T-089 (docs/07 S7.1) olay ekranı cihaz şeridi ve kapsama yardımcıları — saf, test edilir. Cihaz durumu (çevrimiçi,
 * takılı, şarjda, sesli arama sırası) sunucunun T-085 kapsama olgularından gelir; konsol yalnız gösterir.
 */

const WEARABLE = new Set<DeviceCategory>(['WATCH', 'PENDANT', 'RING', 'EARBUD', 'EARRING']);
const CATEGORY_ORDER: DeviceCategory[] = [
  'WATCH',
  'PENDANT',
  'HOME_UNIT',
  'PHONE',
  'RING',
  'EARBUD',
  'EARRING',
  'CLOUD',
];

export const categoryCode = (c: DeviceCategory) => `O-UI-DEV-CAT-${c}`;
export const levelCode = (l: CoverageLevel) => `O-UI-COVERAGE-${l}`;
export const reasonCode = (r: CoverageReason) => `O-UI-COVERAGE-REASON-${r}`;

/** Şeritteki ad: takma ad, yoksa kategori. */
export const deviceLabel = (d: Pick<DeviceSummary, 'nickname' | 'category'>) =>
  d.nickname ?? t(categoryCode(d.category));

/** Şerit sırası: sesli arama sırası (ilk aranacak önce), sonra sessiz cihazlar kategoriye göre. */
export function stripOrder(devices: DeviceSummary[]): DeviceSummary[] {
  const cat = (d: DeviceSummary) => CATEGORY_ORDER.indexOf(d.category);
  return [...devices].sort(
    (a, b) => (a.voiceOrder ?? 99) - (b.voiceOrder ?? 99) || cat(a) - cat(b) || a.id.localeCompare(b.id),
  );
}

/**
 * "Tümünü çaldır" hedefleri (sunucunun S5.2 T+0 kuralıyla aynı): çevrimiçi, şarjda olmayan, çıkarılmamış A sınıfı
 * giyilebilirler (takılı bilgisi yoksa çaldırılır) ve çevrimiçi telefon.
 */
export function ringAllTargets(devices: DeviceSummary[]): DeviceSummary[] {
  return devices.filter(
    (d) =>
      d.online &&
      ((d.tier === 'A' && WEARABLE.has(d.category) && !d.charging && d.onBody !== false) || d.category === 'PHONE'),
  );
}

/** Son görülme: "az önce" (< 1 dk), dk, sa; hiç görülmediyse ayrı metin. */
export function seenText(lastSeenAt: string | null, now: number): string {
  if (!lastSeenAt) return t('O-UI-DEV-SEEN-NEVER');
  const min = Math.floor((now - Date.parse(lastSeenAt)) / 60_000);
  if (min < 1) return t('O-UI-DEV-SEEN-NOW');
  if (min < 60) return t('O-UI-DEV-SEEN-MIN', { n: min });
  return t('O-UI-DEV-SEEN-HOUR', { n: Math.floor(min / 60) });
}

/** Sesli arama rozeti (sesli değilse null). */
export const voiceText = (d: Pick<DeviceSummary, 'voiceOrder' | 'voiceOrderManual'>) =>
  d.voiceOrder === null
    ? null
    : t(d.voiceOrderManual ? 'O-UI-DEV-VOICE-MANUAL' : 'O-UI-DEV-VOICE', { n: d.voiceOrder });

/**
 * KAPSAMA BOŞLUĞU olayının nedeni: olay açılış (CREATED) geçişinin notu neden kodudur (CHARGING, WATCH_OFF,
 * BATTERY_DEAD, CONNECTION_LOST) → katalog O-UI-GAP-<neden>. Bilinmeyen not gösterilmez (serbest metin değil).
 */
export function gapReasonCode(transitions: { to: string; note?: string }[]): string | null {
  const note = transitions.find((x) => x.to === 'CREATED')?.note;
  const code = note ? `O-UI-GAP-${note}` : null;
  return code && /^O-UI-GAP-[A-Z_]+$/.test(code) && has(code) ? code : null;
}

/** Komut sonucunun satırı: ulaştı, cihaz desteklemiyor veya ulaştırılamadı (token yok, sağlayıcı hatası …). */
export const commandResultCode = (r: { sent: boolean; outcome: string }) =>
  r.sent ? 'O-UI-DEV-SENT' : r.outcome === 'unsupported' ? 'O-UI-DEV-UNSUPPORTED' : 'O-UI-DEV-NOT-DELIVERED';
