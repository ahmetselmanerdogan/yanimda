import type { Server } from 'node:http';

/**
 * T-080 (yuk-kaos-v1.md §5): Node boştaki keep-alive bağlantısını varsayılan 5 sn'de kapatır; önündeki vekil /
 * yük dengeleyici aynı bağlantıya o anda yazarsa istek "EOF" / 502 ile düşer. Boşta bekleme vekilinkinden uzun
 * tutulur; başlık süresi ondan büyük olmalı (Node kuralı).
 */
export function configureServerTimeouts(server: Server, env: NodeJS.ProcessEnv = process.env) {
  const keepAlive = Number(env.HTTP_KEEPALIVE_TIMEOUT_MS ?? 65_000);
  server.keepAliveTimeout = keepAlive;
  server.headersTimeout = keepAlive + 1_000;
}
