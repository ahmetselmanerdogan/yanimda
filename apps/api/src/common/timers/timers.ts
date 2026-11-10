/**
 * D-09 zamanlayıcı arayüzü (T-013). Üretim: BullTimers (BullMQ gecikmeli işler, Redis'te kalıcı).
 * Testler: InMemoryTimers. İşleyiciler idempotent ve yarış güvenli olmalı: iş tetiklendiğinde olayın GÜNCEL
 * durumunu okur, hâlâ beklenen durumdaysa geçiş yapar; değilse hiçbir şey yapmaz (en az bir kez teslim).
 */
export const TIMER_KINDS = [
  'prompt-expire', //       cihaz sorusu (düşme) cevapsız → ESCALATED                       (aktif)
  'silent-ask-expire', //   sessiz soru (hareketsizlik) cevapsız → ESCALATED                (aktif)
  'learning-ask-expire', // öğrenme modu 2. sessiz soru cevapsız → ESCALATED (T-070)       (aktif)
  'watch-off-remind', //    saat çıkarıldı → hatırlatma                                     (T-012/T-014 bağlar)
  'watch-off-operator', //  saat çıkarıldı, takılmadı → operatöre                            (T-012/T-014 bağlar)
  'battery-dead', //        pil bitti → BATTERY_DEAD olayı                                    (T-012 bağlar)
  'connection-lost', //     heartbeat yok → CONNECTION_LOST olayı                             (T-012 bağlar)
  'follow-up', //           acil kapanış + 24 saat → FOLLOW_UP olayı                          (aktif)
  'voice-screen-expire', // sesli ön eleme sonucu gelmedi → cevapsız, ESCALATED (T-072)     (aktif)
] as const;

export type TimerKind = (typeof TIMER_KINDS)[number];

export interface TimerJob {
  eventId: string;
  kind: TimerKind;
  data?: Record<string, unknown>;
}

export type TimerHandler = (job: TimerJob) => Promise<void>;

export interface Timers {
  /** Aynı (eventId, kind) için iş zaten bekliyorsa yenisi kurulmaz. Asla reddetmez (Redis yoksa yerel yedek). */
  schedule(eventId: string, kind: TimerKind, delayMs: number, data?: Record<string, unknown>): Promise<void>;
  cancel(eventId: string, kind: TimerKind): Promise<void>;
  /** Tür başına tek işleyici; yeniden kayıt öncekinin yerini alır. */
  on(kind: TimerKind, handler: TimerHandler): void;
}

export const TIMERS = Symbol('TIMERS');

/** BullMQ iş kimliği. Görev metnindeki `<olayId>:<tür>` yerine `.`: BullMQ özel kimlikte ':' kabul etmez. */
export const timerJobId = (eventId: string, kind: TimerKind) => `${eventId}.${kind}`;

export function assertKind(kind: string): asserts kind is TimerKind {
  if (!(TIMER_KINDS as readonly string[]).includes(kind)) throw new Error(`Bilinmeyen zamanlayıcı türü: ${kind}`);
}
