import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration.
 *
 * Runs against the *production* build rather than the dev server, so what is
 * tested is what actually ships — including the real base path, the code-split
 * chunks and the service worker.
 */
const PORT = 4178;
const BASE = `http://localhost:${PORT}/paisatrack/`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The app is India-only; pin the locale and timezone so date and currency
    // assertions do not depend on whoever is running the tests.
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: {
    command: `npm run build:only && npx vite preview --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
