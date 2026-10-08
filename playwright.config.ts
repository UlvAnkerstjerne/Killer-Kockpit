import { defineConfig } from '@playwright/test'

// Fixture-based browser checks (no network, no accounts): see e2e/mobile-today.spec.ts.
export default defineConfig({
  testDir: './e2e',
  reporter: process.env.CI ? 'github' : 'list',
  use: { browserName: 'chromium' },
})
