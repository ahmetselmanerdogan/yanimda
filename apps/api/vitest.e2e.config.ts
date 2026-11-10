import { defineConfig } from 'vitest/config';

/** T-016 uçtan uca + kaos (gerçek süreçler). `pnpm --filter @yanimda/api test:e2e` */
export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } }, // bkz. vitest.config.ts
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
