import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      // MCP server tests (plan 26) — one `npm run test` covers the repo.
      // Requires `npm install` in careervine-mcp/ (see its README).
      '../careervine-mcp/__tests__/**/*.test.ts',
    ],
    setupFiles: ['src/__tests__/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ext': path.resolve(__dirname, '../chrome-extension/src'),
    },
  },
});
