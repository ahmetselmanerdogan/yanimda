/**
 * Kayıtsız cihaz / simülatör sinyalleri açık mı (T-015). SIMULATOR_ENABLED=true|false; boş veya tanımsızsa
 * NODE_ENV !== 'production'. Üretimde kayıtsız cihaz sinyali ve token'sız istek reddedilir.
 */
export const simulatorEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SIMULATOR_ENABLED !== undefined && env.SIMULATOR_ENABLED !== ''
    ? env.SIMULATOR_ENABLED === 'true'
    : env.NODE_ENV !== 'production';
