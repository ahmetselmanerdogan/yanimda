import type { ChainStep, StepResult, StepTarget } from '@yanimda/contracts';

import { isOnline, type LadderDevice, type VoiceTarget } from '../device/device-class';
import type { LadderParams } from '../event/rules.loader';

/**
 * T-087 (docs/07 S5) ulaşılamama merdiveni — saf kurallar. Zincir yürütücüsü (ChainService) adım sırası geldiğinde
 * bunlara bakar; sistem cihazı çaldırır, çevrimdışı adımı atlar, ama 112'yi, komşuyu, anahtar sahibini asla kendisi
 * aramaz ve P1 olayı kapatmaz (S5.8) — bunlar operatörün adımlarıdır.
 */

/** Kişiye yönelik sesli cihaz adımları (saat, telefon, en iyi cihaza yeniden). */
export const DEVICE_TARGETS = new Set<StepTarget>(['WATCH', 'ELDER_PHONE', 'VOICE_DEVICE']);
export const isDeviceStep = (s: Pick<ChainStep, 'target'>) => DEVICE_TARGETS.has(s.target);

/** Sistemin kendiliğinden atladığı adımların gerekçe kodları (katalogda, konsol gösterir). */
export const SKIP = {
  offline: 'O-RES-SKIPPED_OFFLINE',
  away: 'O-SKIP-AWAY',
  impaired: 'O-SKIP-IMPAIRED',
  noKeyHolder: 'O-SKIP-NO-KEY-HOLDER',
} as const;

export interface LadderContext {
  now: Date;
  params: LadderParams;
  devices: LadderDevice[];
  /** S5.9: işitme/konuşma güçlüğü — otomatik cevap ulaşılamadı sayılır, yakınlara daha erken geçilir. */
  impaired: boolean;
  /** S5.5: kişi evden awayFromHomeM'den uzakta (konum ve ev konumu biliniyorsa). */
  awayFromHome: boolean;
  /** S5.6: şu an ulaşılabilir anahtar sahibi kayıtlı mı. */
  hasKeyHolder: boolean;
}

export interface AutoSkip {
  result: Extract<StepResult, 'SKIPPED' | 'OFFLINE_SKIPPED'>;
  reason: string;
}

const devicesFor = (target: StepTarget, devices: LadderDevice[]) =>
  devices.filter((d) => d.voice && (target === 'VOICE_DEVICE' || d.voice === target));

/**
 * Sıradaki adım sistemce atlanmalı mı:
 *  - komşu / anahtar sahibi: kişi evden uzaktaysa (S5.5); anahtar sahibi kayıtlı ve ulaşılabilir değilse
 *  - sesli cihaz: işitme/konuşma güçlüğünde ilk cihaz denemesinden sonrakiler (S5.9); hedefin kayıtlı cihazları var
 *    ama hiçbiri son offlineSkipMin dakikada görülmediyse "çevrimdışı — atlandı" (S5.1). Hiç cihaz kaydı yoksa
 *    (yalnız rehber numarası) atlanmaz: operatör numarayı arar.
 * Aranmaya başlanmış adım atlanmaz.
 */
export function autoSkip(step: ChainStep, done: ChainStep[], ctx: LadderContext): AutoSkip | null {
  if (step.calledAt || step.result) return null;
  if ((step.target === 'NEIGHBOR' || step.target === 'KEY_HOLDER') && ctx.awayFromHome)
    return { result: 'SKIPPED', reason: SKIP.away };
  if (step.target === 'KEY_HOLDER' && !ctx.hasKeyHolder) return { result: 'SKIPPED', reason: SKIP.noKeyHolder };
  if (!isDeviceStep(step)) return null;
  if (ctx.impaired && done.some((s) => isDeviceStep(s) && s.result && s.result !== 'OFFLINE_SKIPPED'))
    return { result: 'SKIPPED', reason: SKIP.impaired };
  const own = devicesFor(step.target, ctx.devices);
  if (own.length && !own.some((d) => isOnline(d, ctx.now, ctx.params.offlineSkipMin)))
    return { result: 'OFFLINE_SKIPPED', reason: SKIP.offline };
  return null;
}

/**
 * S5.2 "en iyi cihaza yeniden" ve S3.3 "ilk sesli arama doğrulayan cihaza": doğrulayan cihaz çevrimiçi ve sesliyse o,
 * değilse en son görülen çevrimiçi sesli cihaz. Yoksa undefined (rehber sırası: saat, telefon).
 */
export function bestVoiceTarget(ctx: LadderContext, preferDeviceId?: string | null): VoiceTarget | undefined {
  const online = ctx.devices.filter((d) => d.voice && isOnline(d, ctx.now, ctx.params.offlineSkipMin));
  const preferred = online.find((d) => d.id === preferDeviceId);
  if (preferred) return preferred.voice!;
  online.sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
  return online[0]?.voice ?? undefined;
}

/**
 * S3.3: doğrulanmış düşmede ilk sesli arama doğrulayan cihaza. Doğrulayan cihaz telefonsa telefon adımı saat
 * adımının önüne alınır (numaralar yeniden verilir); saatse sıra zaten öyledir.
 */
export function orderForCorroboration(steps: ChainStep[], first: VoiceTarget | null | undefined): ChainStep[] {
  if (first !== 'ELDER_PHONE') return steps;
  const watch = steps.findIndex((s) => s.target === 'WATCH');
  const phone = steps.findIndex((s) => s.target === 'ELDER_PHONE');
  if (watch < 0 || phone < 0 || phone < watch) return steps;
  const out = [...steps];
  const [p] = out.splice(phone, 1);
  out.splice(watch, 0, p!);
  return out.map((s, i) => ({ ...s, n: steps[0]!.n + i }));
}

/** S5.5 iki nokta arası uzaklık (m, haversine). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** S5.2: kuyruğa düşüşten 112 son sınırı. Sınır yoksa (tür, test olayı, kuyruğa düşmemiş) null. */
export function call112Deadline(
  ev: { escalatedAt?: string; isTest: boolean },
  deadlineSec: number | null,
): string | null {
  if (!deadlineSec || ev.isTest || !ev.escalatedAt) return null;
  return new Date(Date.parse(ev.escalatedAt) + deadlineSec * 1000).toISOString();
}
