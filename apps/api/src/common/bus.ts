import type { KafkaEnvelope } from '@yanimda/contracts';

export type BusHandler<T> = (e: KafkaEnvelope<T>) => void | Promise<void>;

/**
 * Abone şeridi. `core`: olay motoru ve canlı ekranlar (sinyal → olay → kuyruk/aile bildirimi); sıralı ve
 * önce teslim edilir. `side`: istatistik, faturalama, öğrenme gibi kritik olmayan aboneler; core'u bekletmez,
 * kendi kuyruğundan (event.outbox_side) abone başına sıralı ve yeniden denenerek teslim edilir.
 */
export type Lane = 'core' | 'side';
export interface SubscribeOptions {
  lane?: Lane;
  /** side şeridinde zorunlu: kalıcı abone adı (event.outbox_side.handler). Değiştirilirse bekleyen satırlar düşer. */
  name?: string;
}

/**
 * Olay veri yolu arayüzü (03 "Servis haritası"). v1.0: Postgres outbox + OutboxWorker; v2.0: Kafka.
 * Arayüz aynı kalır: publish(topic, envelope) / subscribe(topic, handler).
 */
export interface Bus {
  publish<T>(topic: string, envelope: KafkaEnvelope<T>): void | Promise<void>;
  subscribe<T>(topic: string, handler: BusHandler<T>, opts?: SubscribeOptions): () => void;
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
  private readonly side = new Map<string, Map<string, BusHandler<unknown>>>();

  publish<T>(topic: string, envelope: KafkaEnvelope<T>): void {
    void this.deliver(topic, envelope).catch(() => undefined);
  }

  subscribe<T>(topic: string, handler: BusHandler<T>, opts: SubscribeOptions = {}): () => void {
    if (opts.lane === 'side') {
      if (!opts.name) throw new Error('side aboneliği için ad zorunlu');
      const name = opts.name;
      const map = this.side.get(topic) ?? new Map<string, BusHandler<unknown>>();
      map.set(name, handler as BusHandler<unknown>);
      this.side.set(topic, map);
      return () => {
        if (map.get(name) === handler) map.delete(name);
      };
    }
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler as BusHandler<unknown>);
    this.handlers.set(topic, set);
    return () => set.delete(handler as BusHandler<unknown>);
  }

  /**
   * lane 'core' (işçi): yalnız core aboneleri. Varsayılan 'all': core sonra side (outbox'sız doğrudan teslim,
   * testler). Biri hata verirse fırlatır (işçi yeniden dener).
   */
  async deliver<T>(topic: string, envelope: KafkaEnvelope<T>, lane: 'core' | 'all' = 'all'): Promise<void> {
    for (const h of [...(this.handlers.get(topic) ?? [])]) await h(envelope);
    if (lane === 'all') for (const h of [...(this.side.get(topic)?.values() ?? [])]) await h(envelope);
  }

  /** Bu konunun side abone adları (işçi her biri için event.outbox_side satırı yazar). */
  sideNames(topic: string): string[] {
    return [...(this.side.get(topic)?.keys() ?? [])];
  }

  /** Tek side aboneye teslim. Abone bu süreçte yoksa false (satır işlenmiş sayılır). */
  async deliverSide<T>(name: string, topic: string, envelope: KafkaEnvelope<T>): Promise<boolean> {
    const h = this.side.get(topic)?.get(name);
    if (!h) return false;
    await h(envelope);
    return true;
  }

  /** Testler için: tüm aboneleri kaldır. */
  clear(): void {
    this.handlers.clear();
    this.side.clear();
  }
}

export const bus = new LocalBus();
