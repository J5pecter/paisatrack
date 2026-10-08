# PaisaTrack — Rules

Boundaries for anyone, human or AI, working on this codebase.

**Last updated:** 2026-10-06

---

## 1. The rules that are not negotiable

### 1.1 Money is integer paise. Always.

```ts
// WRONG — floating point touched money
const total = price * 1.18;
const half  = amount / 2;

// RIGHT
import { mulMoney, divMoney, pctOf } from '@/lib/finance/money';
const total = mulMoney(price, 1.18);
const half  = divMoney(amount, 2);
```

`0.1 + 0.2 !== 0.3`. A finance app that gets this wrong is worthless, and the
error is silent. Integer addition and subtraction are exact; **anything that
multiplies or divides goes through big.js** via the `money.ts` helpers.

Splitting an amount uses `allocate()`, which uses largest-remainder so the parts
sum back to the total exactly. Never `Math.round(total / n)` in a loop.

### 1.2 ₹0 forever, no credit card

If a change requires a paid service, a free tier that can expire, or a card at
signup — **stop and ask**. This is the product's defining constraint, not a
preference.

### 1.3 `lib/finance` stays pure

No React, no Dexie, no `fetch`, no `localStorage`. Pure functions over plain
data. That is why 309 tests run in under a minute and why the numbers are
trustworthy.

It may import from `@/types` and from its own siblings. Nothing else.

### 1.4 All writes go through `lib/db/repository.ts`

Never `db.expenses.put(...)` from a component. The repository stamps
`updatedAt`/`deviceId` and enqueues the sync op; bypassing it silently breaks
sync. The two deliberate exceptions (`seed.ts`, the sync applier) pass
`skipSync` and say why in a comment.

### 1.5 Deletes are soft

Set `deletedAt`. A hard delete cannot propagate, so the other device resurrects
the record on the next pull.

### 1.6 Write the test against the published figure

Not against your own implementation. Bank EMI calculators, HDFC's worked
interest example, the gazetted tax slabs. A test that asserts what the code
already does proves nothing.

---

## 2. Libraries

### Use

| Need | Use | Not |
| --- | --- | --- |
| Money arithmetic | `big.js` via `money.ts` | raw JS numbers, decimal.js |
| Dates | `date-fns` via `dates.ts` | moment, dayjs, raw `Date` maths |
| Local storage | Dexie via `repository.ts` | `localStorage` for domain data |
| Validation | Zod via `lib/validation.ts` | hand-rolled checks |
| Icons | Phosphor via `components/icons.tsx` | importing a second icon set |
| Charts | Recharts via `LazyCharts.tsx` | importing `charts.tsx` directly |
| UI primitives | the kit in `components/ui` | a component library with a runtime |
| HTTP to GitHub | Octokit via `github/client.ts` | raw fetch to the API |

### Do not add

- **Any state manager beyond Zustand.** Domain state belongs in Dexie.
- **A CSS-in-JS runtime.** Tailwind v4 compiles away; emotion/styled-components
  would add runtime cost for nothing.
- **A second icon set.** One, aliased in `icons.tsx`.
- **A date library beyond date-fns.**
- **Anything requiring a server, a paid key, or a card.**
- **Anything over ~50 kB gzipped** without splitting it into a lazy chunk and
  recording the size in `Architecture.md` §7.

### Before adding anything

1. Can the platform do it? (`Intl.NumberFormat` already does Indian digit
   grouping — that is why there is no formatting library.)
2. What does it cost gzipped?
3. Does it force a lazy chunk?
4. Is it maintained, and does it support the current TypeScript?

### Known toolchain constraints

- **`typescript-eslint` does not support TypeScript 7.** It refuses to start.
  Linting is oxlint. Do not "fix" this by downgrading TypeScript. See
  [`LINTING.md`](../LINTING.md).
- **Vite 8 uses Rolldown.** `manualChunks` must be a function, not an object.
- **TypeScript 7 removed `baseUrl`.** Path aliases resolve relative to
  `tsconfig.json`.

---

## 3. Error handling

### Never swallow an error silently

```ts
// WRONG
try { await thing(); } catch {}

// RIGHT — either surface it, or say in a comment why swallowing is correct
try {
  await thing();
} catch (e) {
  toast.error(e instanceof Error ? e.message : 'Could not save.');
}
```

The one acceptable silent catch is where failing would be worse than the
original problem, and the comment must say so — e.g. a broken change-listener
must not fail the write that triggered it.

### Degrade, don't crash

- **Sync fails** → the app keeps working locally; the indicator turns red.
- **Rates unreachable** → keep the existing rates, exit 0.
- **A page throws** → the error boundary catches it and says the data is safe.
- **An animation cannot run** → show the real number immediately. A finance app
  showing ₹0 because `requestAnimationFrame` is paused is lying.

### Error messages say what to do

```
BAD   "Error 403"
BAD   "Something went wrong"
GOOD  "GitHub rejected the write. The token may lack Contents: Read and write,
       or you have hit the rate limit."
```

### Never leak internals to the user

No stack traces, no file paths, no token values, in any user-facing string.

---

## 4. Security

The device is the trust boundary. There is no server, so the usual server-side
controls have no place to live — see §7 for the full matrix. What **does** apply
is applied.

### 4.1 Secrets

- **Never hardcode a secret.** No tokens, keys or credentials in source — the
  repo is public.
- The GitHub token lives in **IndexedDB**, is masked in the UI once saved, and
  is sent **only** to `api.github.com`.
- **Never log it**, never put it in a URL or query string, never include it in
  an error message or a bug report.
- `.env*` is gitignored. So is `data.json` — a real dataset must never land in
  the public app repo.
- Run `npm run scan:secrets` before publishing; CI runs it too.

### 4.2 Input validation

Everything crossing the trust boundary is validated with Zod in
`lib/validation.ts` before it reaches the database:

- CSV import
- JSON backup restore
- `data.json` pulled from GitHub

"There is no server to validate on" is not a reason to skip validation — a
malformed backup file can corrupt the database just as effectively as a
malicious request.

### 4.3 File uploads

Imports are read in-browser and never uploaded anywhere, but they still:

- enforce a **size cap** (5 MB) before reading,
- check the **extension and MIME type**,
- **validate every row** and report what was skipped rather than importing junk.

### 4.4 Output

React escapes by default. **`dangerouslySetInnerHTML` is banned** in this
codebase; if a case ever genuinely needs it, sanitise first and justify it in a
comment.

### 4.5 Injection

Dexie is not a string-query database — there is no query string to concatenate
into, so SQL/NoSQL injection does not arise. Keep it that way: never build a
query by string concatenation if a query language is ever introduced.

### 4.6 Headers

GitHub Pages controls response headers, so CSP is delivered via `<meta>` in
`index.html`. It is restrictive: `connect-src` allows `api.github.com` and, if
and only if the build was given one, a single Cloudflare Worker origin. Any
change that needs a new origin must say why in the commit message.

**The Worker origin is a build-time value, not a setting.** CSP is decided
before any of our code runs, so a URL typed into Settings cannot widen it.
`VITE_WORKER_ORIGIN` is substituted into the policy by a Vite plugin that
asserts the placeholder appears exactly once — it once appeared twice, the
explanatory comment absorbed the substitution, and the real directive shipped
with a literal `%WORKER_ORIGIN%` that browsers silently dropped.

Naming one origin was chosen over `https://*.workers.dev`, which would have let
this page reach every Worker anyone has ever deployed. Unset is the default and
means the build permits no server at all.

`script-src` carries `'wasm-unsafe-eval'`, which permits WebAssembly
instantiation and nothing else — not `eval()` of JavaScript. The OCR engine
needs it.

**The OCR engine is self-hosted, and that is a security decision, not a
packaging one.** Tesseract.js defaults to fetching its worker, its WebAssembly
core and its language model from jsdelivr, and it loads the core *inside the
worker with `importScripts()`* — which `script-src` governs, not
`connect-src`. Taking the default would therefore have meant
`script-src https://cdn.jsdelivr.net`: a third party with script execution in
the origin that holds someone's finances. `scripts/vendor-ocr.mjs` copies the
assets out of `node_modules` at build time instead, which keeps the policy at
`'self'`, makes a scan readable offline, and survives networks that block the
CDN. Do not "simplify" this by deleting the vendoring step.

### 4.7 Production hygiene

- No `console.log` in shipped code (oxlint enforces; `warn`/`error` allowed).
- No debugger statements (oxlint: error).
- Source maps are off in production.

---

## 5. Performance

### Budgets

| Metric | Budget | Measured |
| --- | --- | --- |
| Initial JS (transferred) | ≤ 300 kB | **284 kB** across 16 files |
| Precache total | ≤ 1.5 MB | **2.96 MB** — over, see below |
| Any single eager chunk | ≤ 150 kB gzipped | **119 kB** (`react`) |
| Lighthouse performance | ≥ 90 | **92** |
| Lighthouse accessibility | ≥ 95 | **100** |
| Lighthouse best practices | — | **100** |
| Lighthouse SEO | — | **100** |

Measured 7 Oct 2026 against the production build on Lighthouse's mobile preset
(4× CPU throttle, 1.6 Mbps): FCP 2.1 s, LCP 3.1 s, TBT 80 ms, CLS 0, SI 2.1 s.
Re-measure with:

```bash
npm run build && npx vite preview --port 4180 --strictPort
```

Exceeding a budget is not forbidden — it needs a line here saying what was
bought with it.

**On re-measuring.** Lighthouse's TBT is badly unstable on a machine that is
also running builds and tests — it has been observed swinging between 110ms and
700ms on the *same* bundle, which moves the performance score by fifteen points.
When a change needs to be shown not to have cost anything, measure the
preloaded set instead: the chunks `index.html` actually references are
deterministic, and at the time of writing they total **839.6 kB uncompressed**
(`react` 435, `AppShell` 215, `db` 102, `money` 62, the rest small). If a change
has not moved that list, it has not moved the critical path, whatever a noisy
Lighthouse run says. Re-measure the score on an otherwise idle machine, and
interleave runs against the previous build rather than comparing to a number
recorded on a different day.

**Precache, 2.96 MB against a 1.5 MB budget.** Bought: every page, every chart,
CSV import and PDF export all work offline from the first visit, which is a
stated product requirement. The earlier carve-outs excluded chunks by name, and
when those names stopped existing the exclusions silently matched nothing — a
budget kept by accident is worse than one knowingly spent. Precaching is a
background service-worker install and does not compete with first paint, which
is why the number that actually matters, initial JS, is still inside budget.

**The OCR engine is deliberately NOT in that 2.96 MB.** `public/tesseract/` is
about 14 MB of WebAssembly cores and a language model, and `globIgnores`
excludes it from the precache. Shipping it in the service-worker install would
make every first visit pay for a feature most people never open, on connections
that in India are frequently metered. It is cached at runtime on first use
instead, so the *second* scan works offline and the first one is honest about
what it costs. A given device downloads one core (~3.8 MB) plus the model
(~2.9 MB), once.

### Rules

- **Lazy-load anything over 100 kB** that is not needed for first paint.
- **Memoise anything that walks days.** `runCardLedger` simulates day by day; it
  must sit behind `useMemo`.
- **Debounce text filters.** Not amount or date filters — those change once.
- **Virtualise lists that can exceed ~200 rows.**
- **Read the dashboard atomically.** One live query, not one per table.
- **No N+1 over IndexedDB.** Fetch the table once and join in memory; never
  `await db.x.get(id)` inside a loop.

---

## 6. Code style

- **TypeScript strict.** No `any` without a comment explaining the gap.
- **Comments explain _why_, never _what_.** `// increment i` is noise;
  `// Runs before today's accrual so a lot originating on day X is charged
  exactly daysBetween(X, Y) days` is the reason the line exists.
- **Name after the domain**, not the mechanism: `minimumDue`, not `minAmt`.
- **One screen per file** in `pages/`.
- **No barrel re-exports** that create import cycles. `nav.ts` exists precisely
  because `AppShell` and `CommandPalette` both need the nav model.
- **Hooks before any conditional return.** oxlint enforces it; this was a real
  bug in `CardLedger`.

---

## 7. What does not apply, and why

Standard web-app hardening and scaling advice assumes a server, a database
server, auth, and payments. PaisaTrack has none of those **by design**. Recording
this honestly is better than pretending.

| Item | Status | Why |
| --- | --- | --- |
| Load balancer | **N/A** | Static files on GitHub Pages' CDN. Nothing to balance. |
| Server-side caching | **N/A** | No server. Caching is HTTP + service worker. |
| Database connection pooling | **N/A** | IndexedDB is one in-process connection. |
| Inbound rate limiting | **N/A** | No inbound endpoint. *Outbound* calls to GitHub **are** throttled. |
| Authentication | **N/A** | Single-user, local. The device is the boundary. |
| Server-side permission checks | **N/A** | No server, one user, no privileged routes. |
| "Don't trust frontend user IDs" | **N/A** | No server to trust them *to*. |
| Admin routes | **N/A** | None exist. |
| Firebase / Supabase hardening | **N/A** | Neither is used. |
| SQL/NoSQL injection | **N/A** | Dexie is not string-query based. |
| Rate-limit login/signup | **N/A** | No login. |
| Spending caps | **N/A** | Nothing can incur a charge. |
| Duplicate subscriptions / payments | **N/A** | No payments. |
| Uptime monitoring | **Partial** | GitHub's uptime is the app's. Sync failures surface in-app. |
| Error logging | **None** | No server to ship logs to, and no local error store either — a failure surfaces as a toast or the error boundary, and is gone on reload. Accepted: a single-user app where the user is the one who saw the error. |
| UTM tracking | **Declined** | No analytics, by design. Adding it would mean a third-party request. |
| CDN | **Inherited** | GitHub Pages serves via Fastly. |
| Simultaneous-user testing | **Reframed** | One user, many devices. What is tested is concurrent *device* sync and conflict convergence. |

---

## 8. Working with AI on this repo

### Always

- **Use [Context7](https://context7.com)** for library docs. This project runs
  Vite 8, TypeScript 7, React 19 and Tailwind 4 — newer than most training data.
  Guessing an API here produces confident, wrong code. Add `use context7` to the
  prompt.
- **Run the app and look at it.** Three real bugs in this codebase typechecked
  cleanly, passed unit tests, and were only visible when the page was open:
  animated figures stuck at ₹0, a command palette that would not navigate, and a
  dashboard rendering income against zero spend.
- **Run `npm run test:all`** before claiming anything works.
- **Say what you did not do.** Scope that was skipped, verification that was not
  possible.

### Consider

- **[Graphify](https://github.com/)** for whole-codebase reasoning — it builds a
  queryable knowledge graph across files, which beats repeated grep for
  questions spanning the finance engine, the resolvers and the UI.
- **[21st.dev](https://21st.dev)** for new UI components. It is a copy-in
  registry built to sit beside shadcn/ui primitives, which is exactly what
  `components/ui` already is. Copy the code in and own it; do not add it as a
  dependency.

### Never

- **Never change a finance calculation without a test** that pins the published
  figure.
- **Never relax a type to make an error go away.** The error is the point.
- **Never add a dependency** without checking §2.
- **Never commit a token, a real `data.json`, or a `.env`.**
- **Never claim a feature works because it compiles.**
