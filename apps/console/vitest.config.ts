import { defineConfig } from 'vitest/config';

// Birim testleri yalnız src/; e2e/ Playwright'ındır.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
