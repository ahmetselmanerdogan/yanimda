import { defineConfig, devices } from '@playwright/test';

/**
 * Duyarlı düzen (masaüstü / tablet / telefon) — eğitim modunda (?training=1): giriş ve API gerekmez.
 * `pnpm --filter @yanimda/console test:layout`. Yerelde sistem Chrome'u: PW_CHANNEL=chrome.
 */
const channel = process.env.PW_CHANNEL || undefined;
export default defineConfig({
  testDir: 'e2e-layout',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5174', locale: 'tr-TR', channel, trace: 'retain-on-failure' },
  projects: [
    { name: 'masaustu', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'tablet', use: { viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: 'telefon', use: { ...devices['Pixel 7'], channel, browserName: 'chromium' } },
  ],
  webServer: {
    command: 'pnpm exec vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
  },
});
