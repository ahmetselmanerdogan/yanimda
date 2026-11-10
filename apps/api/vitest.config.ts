import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest 5 / Vite 8 TS dönüşümü oxc ile; test/ tsconfig "include" dışında olduğundan Nest'in eski tip
  // dekoratörleri (experimentalDecorators + emitDecoratorMetadata) burada açıkça istenir.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    globalSetup: ['test/support/redis.global-setup.ts'],
  },
});
