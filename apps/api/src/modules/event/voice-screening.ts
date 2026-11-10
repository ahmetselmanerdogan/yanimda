import type { EventType } from '@yanimda/contracts';

import type { Tx } from '../../db/client';
import type { Rule } from './rules.loader';

/** D-12: sesli ön eleme asla yapılmaz (kural paketi açsa bile; şema da reddeder). */
export const NEVER_SCREEN = new Set<EventType>(['SOS', 'FALL']);

export type ScreeningStatus = 'OK' | 'HELP' | 'UNCLEAR' | 'NO_ANSWER' | 'FAILED';

export interface ScreeningResult {
  status: ScreeningStatus;
  input?: 'DTMF' | 'SPEECH' | null;
  /** Eşleşen katalog terimi (ör. "evet"); ham konuşma dökümü tutulmaz. */
  matched?: string | null;
  confidence?: number | null;
  /** Ör. TIMEOUT, CALL_<durum>. */
  reason?: string;
}

/** Olay geçiş notu (iç kayıt; konsol zaman çizelgesinde görünür). */
export const SCREENING_NOTE: Record<ScreeningStatus, string> = {
  OK: 'sesli ön eleme: iyiyim',
  HELP: 'sesli ön eleme: yardım istedi',
  UNCLEAR: 'sesli ön eleme: anlaşılmadı',
  NO_ANSWER: 'sesli ön eleme: cevapsız',
  FAILED: 'sesli ön eleme: aranamadı',
};

/**
 * T-072 otomatik sesli ön eleme portu. Olay motoru telefoniyi bilmez: ScreeningModule kendini `useScreener` ile
 * bağlar; bağlı değilse (telefoni modülü yok, testler) davranış eskisi gibidir (cevapsız → kuyruk).
 */
export interface VoiceScreener {
  /**
   * Olay kilidi altında (çağıranın transaction'ı): ön eleme satırını yazar (`fresh`). Bu olayda süren ön eleme
   * varsa onu döner (`fresh: false`; tekrar teslim edilen zamanlayıcı yeni arama açmaz). Aranamıyorsa null (kural
   * kapalı, sağlayıcı yok, kişinin numarası yok, bu olayda ön eleme bitti).
   */
  prepare(
    tx: Tx,
    p: { eventId: string; protectedPersonId: string; type: EventType; rule: Rule },
  ): Promise<{ timeoutSec: number; fresh: boolean } | null>;
  /** Commit sonrası aramayı başlatır; başlatılamazsa sonucu FAILED olarak olay motoruna bildirir. Asla reddetmez. */
  dial(eventId: string): Promise<void>;
  /** Olay kilidi altında: bekleyen sonucu kesinleştirir (ilk gelen kazanır). Değiştiyse true. */
  finish(tx: Tx, eventId: string, r: ScreeningResult, sampled: boolean): Promise<boolean>;
  /** Commit sonrası: bekleyen ön eleme iptal (CANCELLED), süren arama kapatılır. Asla reddetmez. */
  abort(eventId: string): Promise<void>;
  /** Commit sonrası: süren aramayı kapatır (süre doldu). Asla reddetmez. */
  hangup(eventId: string): Promise<void>;
}
