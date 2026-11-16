/**
 * Yerel tam yığın (Redis + PGlite sunucusu + API), gerçek kural süreleriyle; yük testi ve elle deneme için.
 *   pnpm --filter @yanimda/api stack:local      → API adresini yazar, Ctrl+C ile kapanır
 * KEYCLOAK_URL verilirse gerçek Keycloak kullanılır (T-020); verilmezse sahte OIDC (STACK_PRINT_TOKEN=1 → ikinci
 * satırda "Bearer …" operatör token'ı, süresi STACK_TOKEN_TTL sn).
 * STACK_API_PORT: sabit API portu (konsol proxy'si ve Playwright için); STACK_TIME_SCALE: kural sürelerini ölçekler.
 */
import { startStack } from './infra';

async function main() {
  const kc = process.env.KEYCLOAK_URL?.replace(/\/+$/, '');
  const st = await startStack({
    timeScale: Number(process.env.STACK_TIME_SCALE ?? 1),
    apiPort: process.env.STACK_API_PORT ? Number(process.env.STACK_API_PORT) : undefined,
    env: kc
      ? { OIDC_OPERATIONS_ISSUER: `${kc}/realms/operations`, OIDC_CONSUMERS_ISSUER: `${kc}/realms/consumers` }
      : {},
  });
  console.log(JSON.stringify({ api: st.api.base, dir: st.dir, oidc: kc ?? st.oidc.base }));
  // Yük testi (k6) token'ı tüm koşu boyunca kullanır: süresi STACK_TOKEN_TTL sn (varsayılan 1 sa).
  if (!kc && process.env.STACK_PRINT_TOKEN)
    console.log(
      `Bearer ${st.oidc.token({ sub: 'op-local', roles: ['OPERATOR'], expInSec: Number(process.env.STACK_TOKEN_TTL ?? 3600) })}`,
    );
  const stop = async () => {
    await st.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
void main();
