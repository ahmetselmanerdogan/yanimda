import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest 5 / Vite 8 TS dönüşümü oxc ile; test/ tsconfig "include" dışında olduğundan Nest'in eski tip
  // dekoratörleri (experimentalDecorators + emitDecoratorMetadata) burada açıkça istenir.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    globalSetup: ['test/support/redis.global-setup.ts'],
    // PGlite + Redis + uygulama açılışı (beforeAll) yük altındaki makinede 10 sn'yi aşabiliyor; CI'da ~2 sn.
    hookTimeout: 60_000,
    // Tek test ~1 sn; paralel derleme (Gradle, turbo) yükü altında 5 sn varsayılanı yanlış alarm verdi.
    testTimeout: 20_000,
  },
});
