import type { QueueItem } from './api';

/** Canlı kuyruk durumu (T-022 mesajlarından). Saf; test edilir. */
export interface QueueState {
  items: QueueItem[];
  /**
   * Son upsert'te ses + üst bar uyarısı gerektiren olay: ilk kez görülen bekleyen olay, önceliği yükselen olay veya
   * yeni alarm gelen olay (denetim bulgu 9).
   */
  arrived?: QueueItem;
  /** Mevcut olaya gelen yeni alarmın türü (varsa). */
  alarm?: string;
}

export type QueueAction =
  | { type: 'snapshot'; items: QueueItem[] }
  | { type: 'upsert'; item: QueueItem; alarm?: string }
  | { type: 'remove'; eventId: string };

/** Öncelik → yaş → kimlik (sunucuyla aynı sıra). */
export const order = (a: QueueItem, b: QueueItem) =>
  a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId);

export function queueReducer(s: QueueState, a: QueueAction): QueueState {
  switch (a.type) {
    case 'snapshot':
      return { items: [...a.items].sort(order) };
    case 'upsert': {
      const prev = s.items.find((i) => i.eventId === a.item.eventId);
      const items = [...s.items.filter((i) => i.eventId !== a.item.eventId), a.item].sort(order);
      const fresh = !prev && a.item.state === 'OPERATOR_QUEUE';
      const raised = !!prev && a.item.priority < prev.priority;
      const arrived = fresh || raised || a.alarm ? a.item : undefined;
      return { items, arrived, ...(a.alarm && arrived ? { alarm: a.alarm } : {}) };
    }
    case 'remove':
      return { items: s.items.filter((i) => i.eventId !== a.eventId) };
  }
}

/** Seçimi koru; seçili olay düştüyse aynı sıradaki (yoksa son) olaya geç. */
export function keepSelection(prev: QueueItem[], next: QueueItem[], selected: string | null): string | null {
  if (!next.length) return null;
  if (selected && next.some((i) => i.eventId === selected)) return selected;
  const idx = selected ? prev.findIndex((i) => i.eventId === selected) : 0;
  return next[Math.min(Math.max(idx, 0), next.length - 1)]!.eventId;
}

const HELD = ['OPERATOR_ASSIGNED', 'CONTACT_CHAIN', 'CONFIRMED_OK', 'CONFIRMED_EMERGENCY', 'DISPATCH'];

/**
 * Devralınabilir mi: operatördeki (teyitli dahil) olayın kilidi dolmuş veya amir bırakmış, ben değilim.
 * Sunucu kuralıyla aynı (EventService.operate claim); sunucu yine 409 ile korur.
 */
export const canTakeOver = (item: QueueItem, me: string, now: number) =>
  HELD.includes(item.state) && item.lockedBy !== me && (!item.lockUntil || new Date(item.lockUntil).getTime() <= now);
