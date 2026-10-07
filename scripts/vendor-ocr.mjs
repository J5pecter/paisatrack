/**
 * Copy the OCR engine out of node_modules and into `public/`, so it is served
 * from our own origin.
 *
 * Tesseract.js defaults to fetching its worker script, its WebAssembly core and
 * its language model from a CDN at runtime. That default was rejected for four
 * reasons, in descending order of importance:
 *
 *   1. CSP. The core is loaded inside the worker with `importScripts()`, which
 *      is governed by `script-src` — so the CDN default would have forced
 *      `script-src https://cdn.jsdelivr.net`. Allowing a third party to execute
 *      script in the origin that holds someone's finances is a much larger
 *      concession than it looks, and it is not one worth making for a
 *      last-resort import path. Self-hosting removes the external origin from
 *      the policy entirely rather than widening it.
 *   2. Offline. This is a PWA whose whole premise is that it works without the
 *      network. "Read my statement" failing on a train would be a bug.
 *   3. Availability. jsdelivr is blocked on some corporate and ISP networks.
 *   4. Privacy. No third party gets to observe that you are reading a statement.
 *
 * The files are copied at build time rather than committed: ~14 MB of binaries
 * in git would be paid for by every clone forever, and npm already pins the
 * exact versions. `public/tesseract/` is gitignored for the same reason.
 *
 * A device downloads ONE core variant (~3.8 MB) plus the language model
 * (~2.9 MB), once, and only if it actually runs OCR.
 */
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'tesseract');

/*
  Only the LSTM cores. `createWorker('eng', 1, …)` asks for OEM 1 — LSTM_ONLY —
  and tesseract.js then picks a `-lstm` build, so the legacy-capable variants
  (another 11 MB) would never be requested.

  All three SIMD tiers ship even though almost every device takes the first.
  getCore chooses by feature detection and loads the result with
  importScripts(), so a missing variant is not a graceful degradation — it is a
  404 surfacing as "Failed to load TesseractCore". The devices that need the
  plain build are old iPhones stuck below iOS 16.4, which is a real population
  in India and exactly the sort of phone whose owner has no better way to get a
  statement in than photographing it. 7.6 MB of build output that most users
  never fetch is a cheap way to not break them.
*/
const CORES = [
  'tesseract-core-relaxedsimd-lstm.wasm.js', // Chrome 114+, Firefox 120+, Safari 18+
  'tesseract-core-simd-lstm.wasm.js', // Chrome 91+, Firefox 89+, Safari 16.4+
  'tesseract-core-lstm.wasm.js', // everything older
];

const files = [
  [join(root, 'node_modules/tesseract.js/dist/worker.min.js'), join(out, 'worker.min.js')],
  // `4.0.0_best_int` is the model tesseract.js pairs with an LSTM-only core.
  // The other model in that package is the 11 MB legacy-capable one, which the
  // core we ship cannot use.
  [
    join(root, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),
    join(out, 'eng.traineddata.gz'),
  ],
  ...CORES.map((name) => [join(root, 'node_modules/tesseract.js-core', name), join(out, name)]),
];

await mkdir(out, { recursive: true });

let copied = 0;
let bytes = 0;
for (const [from, to] of files) {
  const src = await stat(from).catch(() => null);
  if (!src) {
    // A hard failure. Silently shipping a build whose OCR 404s at runtime is
    // worse than not building at all.
    console.error(`vendor-ocr: missing ${from}`);
    console.error('Run `npm ci`. If a tesseract package changed shape, this script needs updating.');
    process.exit(1);
  }

  // Skip bytes that are already in place — this runs before every dev server
  // start as well as every build, and recopying 14 MB each time is pure wait.
  const dst = await stat(to).catch(() => null);
  if (dst && dst.size === src.size) continue;

  await copyFile(from, to);
  copied++;
  bytes += src.size;
}

const version = JSON.parse(
  await readFile(join(root, 'node_modules/tesseract.js/package.json'), 'utf8'),
).version;

console.log(
  copied === 0
    ? `vendor-ocr: public/tesseract already current (tesseract.js ${version})`
    : `vendor-ocr: copied ${copied} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB (tesseract.js ${version})`,
);
