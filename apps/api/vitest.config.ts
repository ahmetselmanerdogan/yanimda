import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    globalSetup: ['test/support/redis.global-setup.ts'],
  },
});
