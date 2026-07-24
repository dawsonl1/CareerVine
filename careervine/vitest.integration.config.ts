import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Integration tier (CAR-178): runs `src/**\/*.itest.ts` against the LOCAL
 * Supabase stack (real Postgres + PostgREST + GoTrue + RLS), never mocks.
 *
 * Deliberately a separate config so the fast unit suite (`npm run test`,
 * vitest.config.ts, `*.test.ts`) never picks these up. Run with:
 *
 *   supabase start          # from the repo root, once
 *   npm run test:integration
 *
 * The global setup resolves the running stack's URL/keys via
 * `supabase status -o env` and refuses anything that is not localhost, so
 * this tier can never point at production.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.itest.ts'],
    globalSetup: ['src/__integration__/global-setup.ts'],
    // One shared database: files must run one at a time, or global sweeps
    // (stale-claim, due-row scans) in one file eat another file's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ext': path.resolve(__dirname, '../chrome-extension/src'),
      '@panel': path.resolve(__dirname, '../chrome-extension/panel-app/src'),
      // Same rationale as vitest.config.ts: `server-only` throws outside
      // React's server layer, so alias it to its own no-op entry point.
      'server-only': path.resolve(__dirname, './node_modules/server-only/empty.js'),
    },
  },
});
