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
    // One fork: tests share a Postgres instance and a single in-memory mock, so
    // serialising avoids cross-file races. Files must still own the data they
    // assert on — `apps/salesforce-mock/src/rest.ts` seeds by *replacing*.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Runs once for the whole run, after every file: puts the canonical demo
    // dataset back (mock + CRM) and removes the suite's rows, so `pnpm test`
    // never breaks `docs/DEMO.md` and the next run starts from the same state.
    globalSetup: ['apps/web/test/global-setup.ts'],
    teardownTimeout: 120_000,
  },
});
