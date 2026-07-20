import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
    setupFiles: ['src/__tests__/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ext': path.resolve(__dirname, '../chrome-extension/src'),
      '@panel': path.resolve(__dirname, '../chrome-extension/panel-app/src'),
      // `server-only` (CAR-158/F39) resolves to a module that THROWS unless the
      // importer sits in React's server layer: its exports map is
      // { "react-server": empty.js, default: index.js } and index.js throws on
      // sight. Next satisfies that condition itself; Vitest does not, so
      // without this every test touching a fenced module dies at import.
      //
      // Alias rather than conditions, deliberately. Setting
      // `ssr.resolve.conditions: ['react-server']` does silence server-only,
      // but the same condition redirects `react-dom/client` to its RSC stub
      // ("react-dom/client is not supported in React Server Components"),
      // which breaks all 30 React component test files. Aliasing the one
      // package to its own no-op entry point is surgical: it leaves every
      // other package's condition resolution untouched.
      'server-only': path.resolve(__dirname, './node_modules/server-only/empty.js'),
    },
  },
});
