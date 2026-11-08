/**
 * Yerel tam yığın (Redis + PGlite sunucusu + API), gerçek kural süreleriyle; yük testi ve elle deneme için.
 *   pnpm --filter @yanimda/api stack:local      → API adresini yazar, Ctrl+C ile kapanır
 */
import { startStack } from './infra';

async function main() {
  const st = await startStack({ timeScale: Number(process.env.STACK_TIME_SCALE ?? 1) });
  console.log(JSON.stringify({ api: st.api.base, dir: st.dir }));
  const stop = async () => {
    await st.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
void main();
