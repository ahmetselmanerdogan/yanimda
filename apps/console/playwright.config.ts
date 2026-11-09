import { defineConfig } from '@playwright/test';

/**
 * Konsol uçtan uca (T-023 kabulü, T-026 senaryoları). Gerçek Keycloak (operations realm, OTP) + API + Vite.
 * Gerekenler: CONSOLE_URL (varsayılan http://localhost:5173), KEYCLOAK_DEV_PASSWORD, KEYCLOAK_DEV_OTP_SECRET
 * (infra/keycloak/dev-users.mjs ile aynı). Yerelde sistem Chrome'u: PW_CHANNEL=chrome.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1, // tek operatör hesabı, ortak kuyruk
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: '../../test-results/console' }]]
    : 'list',
  use: {
    baseURL: process.env.CONSOLE_URL ?? 'http://localhost:5173',
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    locale: 'tr-TR',
    storageState: 'test-results/.auth/operator.json',
  },
  webServer: process.env.CONSOLE_URL
    ? undefined
    : { command: 'pnpm exec vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true },
});
