import type { EventType } from '@yanimda/contracts';

/**
 * E-08 yeni olay sesi (tip bazlı ton dizisi, dosya gerektirmez). P1 (SOS/düşme) üç kısa yüksek ton, diğerleri
 * tek ton. Tarayıcı ses için kullanıcı etkileşimi ister; giriş tıklaması bunu sağlar.
 */
let ctx: AudioContext | undefined;

const PATTERNS: Partial<Record<EventType, number[]>> = {
  SOS: [988, 988, 988],
  FALL: [880, 988, 880],
  INACTIVITY: [660, 660],
};

export function alertSound(type: EventType, priority: number) {
  try {
    ctx ??= new AudioContext();
    const tones = PATTERNS[type] ?? (priority <= 2 ? [740, 740] : [523]);
    tones.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      const at = ctx!.currentTime + i * 0.22;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      o.connect(g).connect(ctx!.destination);
      o.start(at);
      o.stop(at + 0.2);
    });
  } catch {
    /* ses yoksa görsel uyarı yeter */
  }
}
