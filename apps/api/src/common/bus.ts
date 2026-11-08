import type { KafkaEnvelope } from '@yanimda/contracts';

export type BusHandler<T> = (e: KafkaEnvelope<T>) => void | Promise<void>;

/**
 * Olay veri yolu arayüzü (03 "Servis haritası"). v1.0: Postgres outbox + OutboxWorker; v2.0: Kafka.
 * Arayüz aynı kalır: publish(topic, envelope) / subscribe(topic, handler).
 */
export interface Bus {
  publish<T>(topic: string, envelope: KafkaEnvelope<T>): void | Promise<void>;
  subscribe<T>(topic: string, handler: BusHandler<T>): () => void;
}

/**
 * Süreç içi abone dağıtıcısı. Kalıcı yayın OutboxBus'tadır (common/outbox.ts): yazan taraf outbox'a yazar,
 * OutboxWorker satırları `deliver` ile buradaki abonelere verir. `deliver` aboneleri bekler ve hata fırlatırsa
 * işçi yeniden dener (en az bir kez teslim) — aboneler idempotent olmalıdır.
 *
 * Not: `publish` (outbox'sız, anında) yalnız henüz kalıcı olmayan modüller içindir (EventService → T-011b).
 */
export class LocalBus implements Bus {
  private readonly handlers = new Map<string, Set<BusHandler<unknown>>>();

  publish<T>(topic: string, envelope: KafkaEnvelope<T>): void {
    void this.deliver(topic, envelope).catch(() => undefined);
  }

  subscribe<T>(topic: string, handler: BusHandler<T>): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler as BusHandler<unknown>);
    this.handlers.set(topic, set);
    return () => set.delete(handler as BusHandler<unknown>);
  }

  /** Tüm aboneleri sırayla çağırır; biri hata verirse fırlatır (işçi yeniden dener). */
  async deliver<T>(topic: string, envelope: KafkaEnvelope<T>): Promise<void> {
    for (const h of [...(this.handlers.get(topic) ?? [])]) await h(envelope);
  }

  /** Testler için: tüm aboneleri kaldır. */
  clear(): void {
    this.handlers.clear();
  }
}

export const bus = new LocalBus();
