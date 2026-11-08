import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BadRequestException, Injectable } from '@nestjs/common';
import { type Signal, TOPICS } from '@yanimda/contracts';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { v7 as uuidv7 } from 'uuid';

import { bus } from '../../common/bus';

/**
 * D-01 Sinyal alımı: şema doğrulama, idempotency, kalıcı kayıt, signal.received yayını.
 * S0: idempotency bellek içi, kayıt yok. T-010: Timescale yazımı + Kafka üretici + 24 saat idempotency (Redis).
 */
@Injectable()
export class SignalService {
  private readonly validate;
  private readonly seen = new Map<string, number>(); // idempotencyKey -> expiresAt

  constructor() {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const schemaPath = join(__dirname, '../../../../../packages/contracts/schemas/signal.schema.json');
    this.validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  }

  accept(batch: unknown[]): { accepted: number; duplicates: number } {
    if (!Array.isArray(batch) || batch.length === 0) throw new BadRequestException('Boş sinyal listesi');
    let accepted = 0,
      duplicates = 0;
    const now = Date.now();
    for (const raw of batch) {
      if (!this.validate(raw))
        throw new BadRequestException(`Sinyal şemaya uymuyor: ${JSON.stringify(this.validate.errors?.[0])}`);
      const s = raw as Signal;
      const exp = this.seen.get(s.idempotencyKey);
      if (exp && exp > now) {
        duplicates++;
        continue;
      }
      this.seen.set(s.idempotencyKey, now + 24 * 3600 * 1000);
      s.receivedAt = new Date(now).toISOString();
      bus.publish(TOPICS.signalReceived, {
        eventId: uuidv7(),
        type: TOPICS.signalReceived,
        version: 1,
        occurredAt: s.occurredAt,
        countryCode: process.env.COUNTRY_CODE ?? 'TR',
        subjectUserId: s.protectedPersonId,
        payload: s,
      });
      accepted++;
    }
    return { accepted, duplicates };
  }
}
