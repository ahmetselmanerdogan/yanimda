/**
 * T-087 geçici cihaz sınıfı (docs/07 S1.3, S2.1). T-085 cihaz kategori/sınıf sütunlarını getirene kadar türden
 * türetilir; o sütun dolunca `category`/`tier` buradan okunur (tek değişiklik noktası).
 *  - A sınıfı (alarm): Wear OS saat ve simülatör — SOS/düşme açar, takılıyken iptal kabul edilir.
 *  - Sesli cihaz: A sınıfı saat ve yaşlının telefonu — merdivende aranır.
 *  - Yüzük, kulaklık, küpe (ileride) asla aranmaz; yalnız titreşimle soru (S5.1).
 */
export type DeviceTier = 'A' | 'B' | 'C';
export type VoiceTarget = 'WATCH' | 'ELDER_PHONE';

export interface DeviceClass {
  tier: DeviceTier | null;
  /** Merdivende sesli aranabilir mi; hangi hedef (rehber rolü) üzerinden. */
  voice: VoiceTarget | null;
}

const BY_KIND: Record<string, DeviceClass> = {
  WEAROS_WATCH: { tier: 'A', voice: 'WATCH' },
  SIMULATOR: { tier: 'A', voice: 'WATCH' },
  ANDROID_PHONE: { tier: null, voice: 'ELDER_PHONE' },
  IOS_PHONE: { tier: null, voice: 'ELDER_PHONE' },
};

export function classOf(device: { kind: string; category?: string | null; tier?: string | null }): DeviceClass {
  const known = BY_KIND[device.kind];
  if (known) return known;
  // T-085: kategori sütunu (RING, EARBUDS, EARRING …) — sesli aranmaz.
  const tier = device.tier === 'A' || device.tier === 'B' || device.tier === 'C' ? device.tier : null;
  return { tier, voice: null };
}

/** Merdiven için cihaz özeti (numara ve konum yok). */
export interface LadderDevice {
  id: string;
  kind: string;
  tier: DeviceTier | null;
  voice: VoiceTarget | null;
  lastSeenAt: Date | null;
  onWrist: boolean | null;
}

/** S5.1: son `offlineMin` dakikada görüldü mü. */
export const isOnline = (d: Pick<LadderDevice, 'lastSeenAt'>, now: Date, offlineMin: number) =>
  !!d.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() <= offlineMin * 60_000;
