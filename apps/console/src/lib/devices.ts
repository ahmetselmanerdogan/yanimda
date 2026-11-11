import type {
  CoverageLevel,
  CoverageReason,
  DeviceCategory,
  DevicePromptView,
  DeviceSummary,
  WelfareReason,
} from '@yanimda/contracts';

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
  'SENSOR', // T-092: BLE ölçüm cihazı (telefon köprüsü)
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

/** T-087 YERİNDE KONTROL nedeni → katalog O-UI-WELFARE-<neden>; bilinmeyen gösterilmez. */
export function welfareReasonCode(reason: WelfareReason | null | undefined): string | null {
  const code = reason ? `O-UI-WELFARE-${reason}` : null;
  return code && has(code) ? code : null;
}

/** Saat:dakika (operatörün yerel saati). */
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * T-089 (S7.1) operatörün "Soru gönder"ine cihazın cevabı: "İyiyim" (OK), yardım (HELP), cevap yok (NO_ANSWER: süre
 * doldu) veya bekleniyor (kalan sn). Sunucu cevapsızlığı `until`'den işaretler; konsol kendi saatiyle de bekler.
 * `label` sorulan cihazın adı (şerit adıyla aynı).
 */
export function promptLine(p: DevicePromptView, label: string, now: number): string {
  const answer = p.answer ?? (Date.parse(p.until) <= now ? 'NO_ANSWER' : null);
  if (answer === 'OK') return t('O-UI-PROMPT-OK', { device: label, time: hhmm(p.answeredAt ?? p.until) });
  if (answer === 'HELP') return t('O-UI-PROMPT-HELP', { device: label, time: hhmm(p.answeredAt ?? p.until) });
  if (answer === 'NO_ANSWER') return t('O-UI-PROMPT-NO-ANSWER', { device: label, time: hhmm(p.sentAt) });
  return t('O-UI-PROMPT-WAITING', { device: label, sec: Math.max(0, Math.ceil((Date.parse(p.until) - now) / 1000)) });
}

/** Cihaz başına son soru (şeritte gösterilir). */
export function lastPromptByDevice(prompts: DevicePromptView[] | undefined): Map<string, DevicePromptView> {
  const m = new Map<string, DevicePromptView>();
  for (const p of prompts ?? []) {
    const prev = m.get(p.deviceId);
    if (!prev || p.sentAt >= prev.sentAt) m.set(p.deviceId, p);
  }
  return m;
}

/** Bekleyen (cevapsız, süresi dolmamış) soru var mı: konsol cevabı görmek için ayrıntıyı yeniler. */
export const promptPending = (prompts: DevicePromptView[] | undefined, now: number) =>
  (prompts ?? []).some((p) => p.answer === null && Date.parse(p.until) > now - 2_000);

/** Komut sonucunun satırı: ulaştı, cihaz desteklemiyor veya ulaştırılamadı (token yok, sağlayıcı hatası …). */
export const commandResultCode = (r: { sent: boolean; outcome: string }) =>
  r.sent ? 'O-UI-DEV-SENT' : r.outcome === 'unsupported' ? 'O-UI-DEV-UNSUPPORTED' : 'O-UI-DEV-NOT-DELIVERED';
