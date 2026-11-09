import { Global, Logger, Module } from '@nestjs/common';

import { AdminGuard, OidcGuard } from './oidc.guard';
import { oidcConfigFromEnv, OidcVerifier } from './oidc-verifier';

/** T-020 kimlik: Keycloak (operations, consumers) erişim token'ı doğrulama. Tüm modüller kullanır. */
@Global()
@Module({
  providers: [
    {
      provide: OidcVerifier,
      useFactory: () => {
        const v = new OidcVerifier(oidcConfigFromEnv());
        if (!v.enabled)
          new Logger('Identity').warn('KEYCLOAK_URL / OIDC_*_ISSUER yok: kullanıcı girişi gerektiren uçlar 401 döner.');
        return v;
      },
    },
    OidcGuard,
    AdminGuard,
  ],
  exports: [OidcVerifier, OidcGuard, AdminGuard],
})
export class IdentityModule {}
