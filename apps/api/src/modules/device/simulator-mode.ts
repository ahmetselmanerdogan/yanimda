/**
 * Kayıtsız cihaz / simülatör sinyalleri açık mı (T-015). SIMULATOR_ENABLED=true|false; boş veya tanımsızsa
 * NODE_ENV !== 'production'. Üretimde kayıtsız cihaz sinyali ve token'sız istek reddedilir.
 */
export const simulatorEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SIMULATOR_ENABLED !== undefined && env.SIMULATOR_ENABLED !== ''
    ? env.SIMULATOR_ENABLED === 'true'
    : env.NODE_ENV !== 'production';

/**
 * Token'sız (simülatör) sinyal yalnız kayıtlı kişi için mi (emülatör koşusu 2026-11-14 bulgusu)? Açıkken kayıtsız
 * kişiye sinyal 422 alır; kapsama denetimi de olmayan kişi için olay açmaz. Varsayılan kapalı: belgelenmiş simülatör
 * komutu (`--person pp_demo`) ve yük / kaos senaryoları kayıtsız kişi kimlikleri kullanır.
 */
export const simulatorKnownPersonsOnly = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SIMULATOR_KNOWN_PERSONS_ONLY === 'true';
