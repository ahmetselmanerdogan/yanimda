/**
 * Çalışma zamanı yapılandırması: tek konsol imajı her ortamda çalışır. Kap açılışında Caddy `/config.json`'ı ortam
 * değişkenlerinden üretir (infra/console/Caddyfile: CONSOLE_OIDC_AUTHORITY, CONSOLE_OIDC_CLIENT_ID,
 * CONSOLE_API_BASE); konsol açılmadan önce bunu okur. Dosya yoksa / JSON değilse (Vite geliştirme sunucusu,
 * `vite preview`, Playwright) derlemeye gömülü VITE_* değerleri (apps/console/.env.example) kullanılır.
 */
export interface RuntimeConfig {
  /** Keycloak operations realm'i (OIDC issuer). */
  oidcAuthority: string;
  /** Genel (public) PKCE istemcisi. */
  oidcClientId: string;
  /** API kökü; boş = aynı köken `/v1` (Caddy/Ingress yönlendirir). */
  apiBase: string;
}

export const CONFIG_URL = '/config.json';

function fromBuild(): RuntimeConfig {
  return {
    oidcAuthority: import.meta.env.VITE_OIDC_AUTHORITY || 'http://localhost:8080/realms/operations',
    oidcClientId: import.meta.env.VITE_OIDC_CLIENT_ID || 'console',
    apiBase: import.meta.env.VITE_API_BASE || '',
  };
}

let current: RuntimeConfig | undefined;

/** Yüklenmiş yapılandırma; `loadRuntimeConfig` çağrılmadıysa derleme değerleri. */
export function runtimeConfig(): RuntimeConfig {
  return current ?? fromBuild();
}

/** `/config.json` gövdesi: yalnız dolu dize alanlar derleme değerlerini geçersiz kılar (boş alan = varsayılan). */
export function parseRuntimeConfig(raw: unknown, fallback: RuntimeConfig = fromBuild()): RuntimeConfig {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const str = (k: keyof RuntimeConfig) => {
    const v = o[k];
    return typeof v === 'string' && v.trim() ? v.trim().replace(/\/+$/, '') : fallback[k];
  };
  return { oidcAuthority: str('oidcAuthority'), oidcClientId: str('oidcClientId'), apiBase: str('apiBase') };
}

/** Açılışta bir kez: `/config.json` okunur; ulaşılamazsa veya JSON değilse derleme değerleri. Hiç fırlatmaz. */
export async function loadRuntimeConfig(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<RuntimeConfig> {
  try {
    const r = await fetchFn(CONFIG_URL, { cache: 'no-store', headers: { accept: 'application/json' } });
    const json = r.ok && (r.headers.get('content-type') ?? '').includes('application/json');
    current = json ? parseRuntimeConfig(await r.json()) : fromBuild();
  } catch {
    current = fromBuild();
  }
  return current;
}

/** Testler için. */
export function resetRuntimeConfig(): void {
  current = undefined;
}
