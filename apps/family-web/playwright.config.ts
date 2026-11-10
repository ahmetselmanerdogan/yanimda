import { defineConfig } from '@playwright/test';

/**
 * T-082 aile web erişilebilirlik (axe). API çağrıları testte taklit edilir (gerçek API gerekmez).
 * Yerelde sistem Chrome'u: PW_CHANNEL=chrome. Sunucu: üretim derlemesi (`next build && next start`).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.FAMILY_WEB_URL ?? 'http://localhost:5175',
    channel: process.env.PW_CHANNEL || undefined,
    locale: 'tr-TR',
    trace: 'retain-on-failure',
  },
  webServer: process.env.FAMILY_WEB_URL
    ? undefined
    : {
        command: 'pnpm build && pnpm start',
        url: 'http://localhost:5175/kayit',
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
