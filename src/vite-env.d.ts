/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the optional Cloudflare Worker, or an empty string.
   *
   * Substituted by `define` in vite.config.ts, which also writes it into the
   * CSP. Empty is the normal case and means this build permits no server at
   * all — the Settings screen reads it to explain why a Worker URL would be
   * blocked rather than letting the browser fail opaquely.
   */
  readonly VITE_WORKER_ORIGIN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
