import { EventEmitter } from 'node:events';

import type { KafkaEnvelope } from '@yanimda/contracts';

/**
 * S0/S1 geçici olay veri yolu. T-010/T-011'de Kafka (Redpanda) üretici/tüketici ile değiştirilir;
 * arayüz aynı kalır: publish(topic, envelope) / subscribe(topic, handler).
 * KURAL: olay kaybı sıfır — gerçek uygulamada publish kalıcı kuyruğa yazar, burada yalnız geliştirme içindir.
 */
export class Bus {
  private readonly em = new EventEmitter();
  publish<T>(topic: string, envelope: KafkaEnvelope<T>) {
    this.em.emit(topic, envelope);
  }
  subscribe<T>(topic: string, handler: (e: KafkaEnvelope<T>) => void | Promise<void>) {
    this.em.on(topic, handler);
  }
}
export const bus = new Bus();
