import type { QueueItem } from './api';

/** Canlı kuyruk durumu (T-022 mesajlarından). Saf; test edilir. */
export interface QueueState {
  items: QueueItem[];
  /** Son upsert'te ilk kez görülen bekleyen olay (ses + üst bar uyarısı için). */
  arrived?: QueueItem;
}

export type QueueAction =
  { type: 'snapshot'; items: QueueItem[] } | { type: 'upsert'; item: QueueItem } | { type: 'remove'; eventId: string };

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
      const arrived = !prev && a.item.state === 'OPERATOR_QUEUE' ? a.item : undefined;
      return { items, arrived };
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
