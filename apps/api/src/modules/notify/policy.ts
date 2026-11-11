import type { EventState, EventType } from '@yanimda/contracts';

/**
 * T-053 (D-08) bildirim kuralları — saf fonksiyonlar, tablo testiyle sabitlenir.
 *
 * Aile bildirimi hangi geçişte:
 *  - Olay ilk kez operatör kuyruğuna düşünce (kilit düşmesi / amir geri alması hariç): FALL → F-EVT-FALL,
 *    SOS → F-EVT-SOS, WATCH_OFF → F-WATCH-OFF-4H, CONNECTION_LOST → F-CONN-LOST
 *  - DISPATCH (112'ye ulaşıldı) → F-EVT-112
 *  - Kişi saatten iptal etti (CANCELLED_BY_USER → CLOSED), FALL/SOS → F-EVT-OK
 *  - Takip araması iyi kapandı (FOLLOW_UP, OK) → F-FOLLOWUP
 * Test olayları (T-063) yalnız "test" kodlarıyla: kuyruğa düşünce F-TEST-QUEUED, kapanınca F-TEST-DONE.
 */
export interface EventFacts {
  id: string;
  type: EventType;
  isTest: boolean;
  confirmedOutcome: string | null;
}
export interface TransitionFacts {
  from?: EventState;
  to: EventState;
}

const QUEUE_CODE: Partial<Record<EventType, string>> = {
  FALL: 'F-EVT-FALL',
  SOS: 'F-EVT-SOS',
  WATCH_OFF: 'F-WATCH-OFF-4H',
  CONNECTION_LOST: 'F-CONN-LOST',
};
/** Kuyruğa dönüş (ilk düşüş değil): aile zaten bilgilendirildi. */
const REQUEUE_FROM = new Set<EventState>(['OPERATOR_ASSIGNED', 'CONTACT_CHAIN']);

export function familyNoticeFor(ev: EventFacts, t: TransitionFacts): string | null {
  if (ev.isTest) {
    if (t.to === 'OPERATOR_QUEUE' && !(t.from && REQUEUE_FROM.has(t.from))) return 'F-TEST-QUEUED';
    return t.to === 'CLOSED' ? 'F-TEST-DONE' : null;
  }
  if (t.to === 'OPERATOR_QUEUE' && !(t.from && REQUEUE_FROM.has(t.from))) return QUEUE_CODE[ev.type] ?? null;
  if (t.to === 'DISPATCH') return 'F-EVT-112';
  if (t.to === 'CLOSED' && t.from === 'CANCELLED_BY_USER' && (ev.type === 'FALL' || ev.type === 'SOS'))
    return 'F-EVT-OK';
  if (t.to === 'CLOSED' && ev.type === 'FOLLOW_UP' && ev.confirmedOutcome === 'OK') return 'F-FOLLOWUP';
  return null;
}

export type Urgency = 'URGENT' | 'INFO';
export interface Delivery {
  urgency: Urgency;
  /** URGENT: push + SMS (tüm yakınlar) + sesli arama (ilk yakın) paralel. */
  parallelSmsVoice: boolean;
  /** INFO: push bu sürede teslim edilmezse (uygulama onayı yok / push başarısız) ilk yakına SMS. null = yedek yok. */
  smsFallbackSec: number | null;
}

const URGENT: Delivery = { urgency: 'URGENT', parallelSmsVoice: true, smsFallbackSec: null };
const INFO: Delivery = { urgency: 'INFO', parallelSmsVoice: false, smsFallbackSec: 10 };
/** Akış bilgisi: yalnız push (aile o olaydan haberdar değildi; SMS gürültü olur). */
const FEED: Delivery = { urgency: 'INFO', parallelSmsVoice: false, smsFallbackSec: null };

const DELIVERY: Record<string, Delivery> = {
  'F-EVT-FALL': URGENT,
  'F-EVT-SOS': URGENT,
  'F-EVT-112': URGENT,
  'F-112-ON-SCENE': INFO, // 112 süreci: ekip ulaştı
  'F-112-TRANSPORT': INFO, // 112 süreci: hastaneye nakil
  'F-112-HOSPITAL': INFO, // 112 süreci: hastaneye ulaştı
  'F-WATCH-OFF-4H': INFO,
  'F-CONN-LOST': INFO,
  'F-BAT-10': INFO,
  'F-FOLLOWUP': INFO,
  'F-SUB-PAY': INFO,
  'F-SUB-SUSPENDED': INFO, // T-060 ödeme bekleme süresi doldu, koruma askıda
  'F-TEST-DONE': INFO,
  'F-EVT-OK': FEED,
  'F-TEST-QUEUED': FEED,
  'F-DAILY': FEED,
  'F-LEARN-REPORT': FEED, // T-070 dönem sonu profil raporu
  'F-FA-REVIEW': INFO, //   T-071 eşik önerisi (operatör arayacak)
  'F-PERM': INFO, //        T-042 telefonda izin eksik (kurulum durumu)
};

/** Aile kodları için teslim biçimi; kişinin kendi cihazına giden kodlar (W-*, P-*) yalnız cihaz push'u. */
export function deliveryFor(code: string): Delivery {
  return DELIVERY[code] ?? INFO;
}
