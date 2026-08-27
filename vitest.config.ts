import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Picks up the @/* path alias from tsconfig.json — no plugin needed.
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    globals: true,
  },
})
