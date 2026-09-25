import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // Next resolves this to a no-op on the server; outside Next it throws.
      'server-only': fileURLToPath(new URL('./lib/server/__tests__/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    // Each database test file boots its own PGlite (under a second, but
    // slower on a cold CI runner than the 10s default allows).
    hookTimeout: 30_000,
  },
});
