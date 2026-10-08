import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Picks up the @/* path alias from tsconfig.json — no plugin needed.
    tsconfigPaths: true,
    alias: {
      // server-only is a build-time marker that throws when imported in
      // client bundles. In tests there is no client/server boundary, so
      // we resolve it to an empty module.
      'server-only': new URL('./__tests__/helpers/server-only-stub.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // Playwright specs live in e2e/ and run via `npm run test:e2e`.
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**'],
  },
})
