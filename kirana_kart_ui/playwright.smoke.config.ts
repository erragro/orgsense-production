import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  testMatch: ['smoke/**/*.spec.ts', 'access.e2e.spec.ts'],
  use: { baseURL: process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: process.env.SMOKE_BASE_URL ? undefined : {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI,
  },
})
