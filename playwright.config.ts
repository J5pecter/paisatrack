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

/**
 * The stand-in for the Worker.
 *
 * The app has no local storage any more, so there is nothing to test against
 * without a server. This one runs the real `worker/src/data.ts` over an
 * in-memory map and namespaces by token, so parallel tests cannot see each
 * other's records. See e2e/server.mjs.
 */
const SERVER_PORT = 8788;
const SERVER = `http://localhost:${SERVER_PORT}`;

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

  webServer: [
    {
      command: `npx tsx e2e/server.mjs`,
      url: `${SERVER}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { E2E_SERVER_PORT: String(SERVER_PORT) },
    },
    {
      command: `npm run build:only && npx vite preview --port ${PORT} --strictPort`,
      url: BASE,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      /*
        The Worker origin is compiled into the Content Security Policy, so the
        build the tests run against has to name the test server — otherwise
        every request is blocked before it is sent and every test fails with an
        empty page and no explanation.
      */
      env: { VITE_WORKER_ORIGIN: SERVER },
    },
  ],
});
