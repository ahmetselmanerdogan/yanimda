import { Logger, Module, ServiceUnavailableException } from '@nestjs/common';

import { ProfileModule } from '../profile/profile.module';
import { ProfileService } from '../profile/profile.service';
import type { CpaasProvider } from '../telephony/cpaas';
import { TelephonyModule } from '../telephony/telephony.module';
import { CPAAS } from '../telephony/telephony.service';
import { BillingController, SubscriptionController } from './billing.controller';
import {
  BILLING_CONFIG,
  BILLING_PROFILE,
  BILLING_SMS,
  type BillingConfig,
  BillingService,
  CONSUMER_ACCOUNTS,
  PAYMENT_PROVIDERS,
} from './billing.service';
import {
  type ConsumerAccounts,
  FakeConsumerAccounts,
  keycloakAdminConfigFromEnv,
  KeycloakConsumerAccounts,
} from './consumer-accounts';
import { providersFromEnv } from './providers/registry';
import { signupSecret } from './signup-token';

export function billingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  return {
    signupSecret: signupSecret(env),
    webBase: (env.FAMILY_WEB_URL || 'http://localhost:5175').replace(/\/+$/, ''),
    apiBase: (env.PUBLIC_API_URL || env.CPAAS_WEBHOOK_BASE || 'http://localhost:3000').replace(/\/+$/, ''),
    kvkkNoticeVersion: env.KVKK_NOTICE_VERSION || 'taslak-2026-11',
    exposeDevCode: env.NODE_ENV !== 'production' && env.SIGNUP_DEV_CODE !== 'off',
    env,
    sweepMs: Number(env.BILLING_SWEEP_MS ?? 60_000),
  };
}

function accountsFromEnv(env: NodeJS.ProcessEnv = process.env): ConsumerAccounts {
  const cfg = keycloakAdminConfigFromEnv(env);
  if (cfg) return new KeycloakConsumerAccounts(cfg);
  const log = new Logger('Billing');
  if (env.NODE_ENV === 'production') {
    log.error('KEYCLOAK_SIGNUP_CLIENT_SECRET yok: web kaydı kapalı');
    const off = () => Promise.reject(new ServiceUnavailableException('Kayıt geçici olarak kapalı'));
    return { create: off, sendSetupEmail: off, markPhoneVerified: off, contactOf: off, remove: off };
  }
  log.warn('KEYCLOAK_SIGNUP_CLIENT_SECRET yok: kayıt hesapları bellekte (sahte Keycloak)');
  return new FakeConsumerAccounts();
}

/** T-060 (C-01) web abonelik ve ödeme. Profil (kişi + sahiplik) ProfileModule'den, SMS TelephonyModule'den. */
@Module({
  imports: [ProfileModule, TelephonyModule],
  controllers: [BillingController, SubscriptionController],
  providers: [
    BillingService,
    { provide: BILLING_CONFIG, useFactory: () => billingConfigFromEnv() },
    { provide: PAYMENT_PROVIDERS, useFactory: () => providersFromEnv() },
    { provide: CONSUMER_ACCOUNTS, useFactory: () => accountsFromEnv() },
    { provide: BILLING_PROFILE, useExisting: ProfileService },
    { provide: BILLING_SMS, inject: [CPAAS], useFactory: (c: CpaasProvider | null) => c },
  ],
  exports: [BillingService],
})
export class BillingModule {}
