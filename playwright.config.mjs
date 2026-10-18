import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', workers: 1, timeout: 30000,
  use: { baseURL: process.env.BROWSER_BASE || 'http://localhost:8794', headless: true },
  webServer: process.env.BROWSER_BASE ? undefined : {
    command: 'npm run dev -- --port 8794', url: 'http://localhost:8794',
    reuseExistingServer: false, timeout: 60000,
  },
});
