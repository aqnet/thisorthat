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
    // `npm run test:coverage`. Scoped to what unit and integration tests can
    // reach: the engine, the server, Server Actions, the advance route and the
    // client sync helpers. Screens (*.tsx) are covered by the browser scripts
    // in e2e/, so they're left out rather than counted as 0%.
    coverage: {
      provider: 'v8',
      include: [
        'lib/engine/**/*.ts',
        'lib/server/**/*.ts',
        'lib/game/**/*.ts',
        'lib/client/roomSync.ts',
        'lib/client/playerName.ts',
        'app/actions.ts',
        'app/api/**/*.ts',
      ],
      exclude: ['**/__tests__/**'],
      reporter: ['text-summary', 'text', 'html'],
      reportsDirectory: 'coverage',
      // Just under today's numbers (96.9 / 90.3 / 94.9 / 95.0): a drop fails the run.
      thresholds: { lines: 95, branches: 88, functions: 92, statements: 93 },
    },
  },
});
