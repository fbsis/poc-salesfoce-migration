import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/.next/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One fork: tests share a Postgres instance, serialising avoids cross-file races.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
