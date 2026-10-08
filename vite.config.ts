import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';

/**
 * The vendored OCR engine's version, used to name its runtime cache so an
 * upgrade cannot serve a core and a language model from different releases.
 */
const TESSERACT_VERSION: string = createRequire(import.meta.url)('tesseract.js/package.json').version;

/**
 * The optional Cloudflare Worker's origin, baked into the CSP at build time.
 *
 * It has to be a build-time value rather than a setting, because CSP is a
 * static `<meta>` on a site with no control over response headers — the browser
 * decides what the page may talk to before any of our code runs.
 *
 * The alternative was allowing `https://*.workers.dev`, which would have meant
 * every page on this origin could reach every Worker anyone has ever deployed.
 * Naming one origin keeps the policy as tight as it was before the Worker
 * existed. The cost is a rebuild to change it, which is a deploy either way.
 *
 * Unset is the normal case: the app ships with no server, the CSP gains
 * nothing, and the Settings screen says the Worker is not permitted by this
 * build rather than letting the browser fail with an unexplained network error.
 *
 *   VITE_WORKER_ORIGIN=https://paisatrack.you.workers.dev npm run build
 */
const WORKER_ORIGIN: string = (() => {
  const raw = process.env.VITE_WORKER_ORIGIN?.trim();
  if (!raw) return '';
  try {
    const { origin, protocol } = new URL(raw);
    // An http: Worker would silently downgrade everything the page sends it,
    // and `upgrade-insecure-requests` would rewrite it anyway.
    if (protocol !== 'https:') {
      throw new Error(`VITE_WORKER_ORIGIN must be https. Got: ${raw}`);
    }
    return origin;
  } catch (e) {
    // Failing the build beats shipping a CSP with a mangled source in it,
    // which browsers handle by ignoring the whole directive.
    throw new Error(`VITE_WORKER_ORIGIN is not a valid URL: ${raw} (${(e as Error).message})`);
  }
})();

// Base path must match the GitHub Pages repo name.
// deploy.yml sets VITE_BASE_PATH=/<repo-name>/ automatically so this is always correct.
/** Placeholder substituted into the CSP's connect-src. Must appear once in index.html. */
const MARKER = '%WORKER_ORIGIN%';

const base = process.env.VITE_BASE_PATH ?? '/paisatrack/';

/**
 * Chunks that must never be preloaded from index.html: each is reached only
 * through a dynamic import, and each is big enough to matter on a phone.
 * jsPDF and Recharts are absent because they are no longer named chunks —
 * natural splitting already keeps them behind their lazy routes.
 */
const DEFER_FROM_HTML = /vendor-(github|csv|validation)-/;

export default defineConfig({
  base,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    // Read by src/lib/server/config.ts so the Settings screen can tell the user
    // whether the origin they typed is the one this build's CSP permits.
    'import.meta.env.VITE_WORKER_ORIGIN': JSON.stringify(WORKER_ORIGIN),
  },
  plugins: [
    {
      /*
        Substitute the Worker origin into the CSP.

        A marker rather than a regex over the policy: a replacement that
        silently matched nothing would ship a page that cannot reach the
        Worker, and the failure would surface as a browser console message
        nobody reads. If the marker is missing, this throws.
      */
      name: 'paisatrack-csp-worker-origin',
      enforce: 'pre' as const,
      transformIndexHtml(html: string) {
        /*
          Exactly one, asserted.

          `String.replace` with a string pattern substitutes only the FIRST
          match. The token used to appear twice — once in the comment above the
          policy, explaining itself, and once in the policy — so the comment
          absorbed the substitution and the real directive shipped with a
          literal `%WORKER_ORIGIN%` in it. Browsers respond to an unparseable
          source by dropping it, which fails silently and at runtime.

          Counting is the cheap fix. Zero means someone removed the marker;
          more than one means a second copy is about to eat the replacement.
        */
        const occurrences = html.split(MARKER).length - 1;
        if (occurrences !== 1) {
          throw new Error(
            `index.html must contain ${MARKER} exactly once in its CSP; found ${occurrences}.`,
          );
        }
        return html.replace(MARKER, WORKER_ORIGIN);
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PaisaTrack',
        short_name: 'Paisa',
        description: 'Personal finance tracker for India',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        /*
          Push and notification-click handling, which Workbox's generated
          service worker has no notion of. `importScripts` is the supported
          seam in generateSW mode; owning the whole service worker instead
          would mean hand-maintaining the precache registration below.
        */
        importScripts: ['push-sw.js'],
        // Precache everything the build emits, so the whole app — every page,
        // every chart, CSV import and PDF export — works offline from the first
        // visit. That is a stated requirement, and the alternative is a user
        // discovering on a train that Reports needs the network.
        //
        // This list used to carve out named vendor chunks, but those names no
        // longer exist: jsPDF and Recharts are now split naturally behind the
        // lazy routes that use them (see manualChunks below), so the carve-outs
        // silently matched nothing. Precaching is a background service-worker
        // install and does not compete with first paint, so the simple rule —
        // if it shipped, it works offline — is the one worth keeping.
        globPatterns: ['**/*.{css,html,ico,png,svg,woff2,js}'],
        globIgnores: [
          '**/vendor-github-*.js', // sync needs the network anyway
          /*
            The OCR engine is 14 MB and most people never touch it. Precaching
            it would make the very first visit download a WebAssembly core and
            a language model to support a path the user may never take, on a
            connection that in India is frequently metered. It is cached at
            runtime instead — see `runtimeCaching` below — so the second scan
            works offline and the first one is honest about what it costs.
          */
          '**/tesseract/**',
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // GitHub API is the sync backend — never serve a stale write response.
            urlPattern: /^https:\/\/api\.github\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/raw\.githubusercontent\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'github-raw',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            /*
              The OCR engine: downloaded on first use, kept forever after.
              CacheFirst because these bytes are immutable for a given version
              — the cache name carries the tesseract.js version, so an upgrade
              simply starts a new cache rather than serving a core and a
              language model that disagree.

              This is what makes a second scan work on a train, and it is the
              reason the engine is worth self-hosting at all: a CDN fetch can
              never be cached by our own service worker on an opaque response.
            */
            urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.includes('/tesseract/'),
            handler: 'CacheFirst',
            options: {
              cacheName: `ocr-engine-${TESSERACT_VERSION}`,
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    modulePreload: {
      /**
       * Keep the heavy, lazily-imported vendors out of index.html.
       *
       * Vite preloads every chunk reachable from the entry, including ones
       * only ever reached through a dynamic import. That silently undid the
       * code splitting: the dashboard fetched vendor-pdf (229 kB) and
       * vendor-charts (115 kB) in the very first request burst, where they
       * competed with the shell for bandwidth and pushed LCP out to 5 s on a
       * throttled phone. They are still fetched on demand by the dynamic
       * import that needs them, so this changes WHEN, not WHETHER.
       */
      resolveDependencies(_filename, deps, { hostType }) {
        if (hostType !== 'html') return deps;
        return deps.filter((dep) => !DEFER_FROM_HTML.test(dep));
      },
    },
    // The pdf chunk (jsPDF + html2canvas) is ~780 kB and is only fetched when
    // someone exports a report. Warning about it on every build would train us
    // to ignore the warning.
    chunkSizeWarningLimit: 800,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Vite's dynamic-import helpers are virtual modules, so they carry no
          // node_modules path and the early return below left them unassigned.
          // Rolldown then parked __vitePreload inside vendor-pdf, and because
          // every chunk that performs a dynamic import
          // must reach that helper, all of them gained a static import of
          // vendor-pdf — dragging 780 kB of jsPDF onto the critical path and
          // quietly undoing the code splitting. Pin the helpers to their own
          // chunk so they can never be captured by a vendor bundle again.
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'vite-helpers';
          }
          if (!id.includes('node_modules')) return;
          // Recharts is likewise left to natural splitting: components/charts.tsx
          // is its only importer and LazyCharts reaches that lazily, so it is
          // already isolated. Grouping it had the same side effect as the pdf
          // group — Rolldown routed shared helpers through the vendor chunk and
          // made the app shell depend on it statically.
          // jsPDF, html2canvas and their dependencies are deliberately NOT
          // grouped. Reports is their only importer and it is lazy, so Rolldown
          // already isolates them behind that dynamic import. Forcing them into
          // a shared "vendor-pdf" chunk actively hurt: Rolldown then placed the
          // __vitePreload helper inside it, which made every chunk that does a
          // dynamic import statically import 780 kB of jsPDF. Leave them alone.
          if (id.includes('@octokit') || id.includes('universal-user-agent') || id.includes('before-after-hook')) return 'vendor-github';
          if (id.includes('dexie')) return 'db';
          if (id.includes('papaparse')) return 'vendor-csv';
          if (id.includes('/zod/')) return 'vendor-validation';
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'react';
          return;
        },
      },
    },
  },
});
