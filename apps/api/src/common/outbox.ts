import { EventEmitter } from 'node:events';

import type { KafkaEnvelope } from '@yanimda/contracts';

import type { Db, Tx } from '../db/client';
import { outbox } from '../db/schema';

/**
 * Transactional outbox yazıcısı (T-010, v1.0). Yayın, iş verisiyle AYNI transaction'da event.outbox'a yazılır;
 * böylece "kaydedildi ama yayınlanmadı" / "yayınlandı ama kaydedilmedi" durumu oluşmaz (olay kaybı sıfır).
 * Teslimat OutboxWorker'dadır.
 */
export class OutboxBus {
  private readonly signals = new EventEmitter();

  constructor(private readonly db: Db) {}

  /** `tx` verilirse çağıranın transaction'ına katılır (önerilen); verilmezse tek başına yazar. */
  async publish<T>(topic: string, envelope: KafkaEnvelope<T>, tx?: Tx): Promise<void> {
    await (tx ?? this.db).insert(outbox).values({ topic, envelope });
  }

  /** Commit sonrası çağrılır: süreç içi işçiyi hemen uyandırır (yoklama aralığını beklemeden). */
  notifyCommitted(): void {
    this.signals.emit('committed');
  }

  onCommitted(fn: () => void): () => void {
    this.signals.on('committed', fn);
    return () => this.signals.off('committed', fn);
  }
}
