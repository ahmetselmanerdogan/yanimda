import { Logger, Module } from '@nestjs/common';

import type { CpaasProvider } from './cpaas';
import { FakeProvider } from './fake-cpaas';
import { type RecordingStore, s3ConfigFromEnv, S3RecordingStore } from './recording-store';
import { ContactsController, CpaasWebhookController } from './telephony.controller';
import { CPAAS, RECORDINGS, TelephonyService } from './telephony.service';
import { twilioConfigFromEnv, TwilioProvider } from './twilio';

const log = new Logger('Telephony');

/** CPAAS_PROVIDER: twilio | fake (geliştirmede varsayılan) | off. Üretimde sahte sağlayıcı yok, kayıt S3'e zorunlu. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): CpaasProvider | null {
  const prod = env.NODE_ENV === 'production';
  const kind = env.CPAAS_PROVIDER || (prod ? 'off' : 'fake');
  if (kind === 'off') return null;
  if (kind === 'twilio') {
    const cfg = twilioConfigFromEnv(env);
    if (!cfg)
      throw new Error('CPAAS_PROVIDER=twilio için TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER gerekli');
    if (prod && !s3ConfigFromEnv(env)) throw new Error('Üretimde görüşme kaydı için S3_* gerekli');
    return new TwilioProvider(cfg);
  }
  if (kind === 'fake') {
    if (prod) throw new Error('Üretimde CPAAS_PROVIDER=fake kullanılamaz');
    log.warn('Sahte CPaaS: gerçek arama yapılmaz (son hane 0 cevap yok, 1 meşgul, 9 hatalı, diğerleri açar)');
    return new FakeProvider();
  }
  throw new Error(`Bilinmeyen CPAAS_PROVIDER: ${kind}`);
}

/** T-050 telefoni (E-05): giden arama, webhook, kayıt. */
@Module({
  providers: [
    TelephonyService,
    { provide: CPAAS, useFactory: () => providerFromEnv() },
    {
      provide: RECORDINGS,
      useFactory: async (): Promise<RecordingStore | null> => {
        const cfg = s3ConfigFromEnv();
        if (!cfg) return null;
        const store = new S3RecordingStore(cfg);
        // Geliştirme: kovayı nesne kilidiyle oluştur. Üretimde kova altyapıyla (Terraform) kurulur.
        if (process.env.S3_ENSURE_BUCKET === 'true')
          await store.ensureBucket().catch((e) => log.warn(`S3 kovası hazırlanamadı: ${(e as Error).message}`));
        return store;
      },
    },
  ],
  controllers: [CpaasWebhookController, ContactsController],
  exports: [TelephonyService],
})
export class TelephonyModule {}
