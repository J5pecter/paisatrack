import { defineConfig } from 'vitest/config';

/**
 * The Worker is a separate deployable with a separate toolchain, and its tests
 * live with it rather than in the app's suite for a type reason: importing
 * worker/src into the app's program would pull `@cloudflare/workers-types`
 * globals — `Ai`, `KVNamespace`, a different `fetch` — into the type space of
 * a browser app that is not a Worker.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
