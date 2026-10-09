# PaisaTrack — Architecture

**Last updated:** 2026-10-06

---

## 1. The shape of it

A static bundle on a CDN, and one small server holding one small database.

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER  (github.io — static, no server-side anything)             │
│                                                                     │
│   React 19 ── TanStack Router ── Zustand (UI state only)            │
│        │                                                            │
│        │ reads, synchronously from memory                           │
│        ▼                                                            │
│   lib/store/records ─── frozen array per table                      │
│        ▲                     │                                      │
│        │ confirmed writes    │ useSyncExternalStore                 │
│        │                     ▼                                      │
│   lib/db/repository      every page and hook                        │
│        │   THE ONLY WRITE PATH                                      │
└────────┼────────────────────────────────────────────────────────────┘
         │  HTTPS, Bearer token, CSP-pinned to one origin
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CLOUDFLARE WORKER  (the user's own account, free plan, no card)    │
│                                                                     │
│   GET  /data        everything, assembled by string concatenation   │
│   POST /data/write  a batch of upserts and deletes, one D1 txn      │
│   POST /ocr         a vision model reads a scan        (opt-in)     │
│   POST /push/*  +   a daily cron sends a bodiless nudge (opt-in)    │
│        │                                                            │
│        ▼                                                            │
│   D1 — one table, `records`, each row the JSON the client sent      │
└─────────────────────────────────────────────────────────────────────┘
```

### Why this shape

**One copy.** PaisaTrack was local-first until October 2026 and the data lived
in IndexedDB, with an optional GitHub sync. That design answered "offline" well
and "which device has my data?" badly — a phone and a laptop each held a
partial copy, and the code to reconcile them was the most intricate in the
project. One database removes the question rather than answering it.

**No account system.** One dataset, one token. Anyone holding the token is the
owner. That is the right shape for one person's finances and the wrong shape
for anything else.

**The finance engine never moved.** Every rupee figure is still computed in the
browser by the pure functions in `lib/finance`. The server stores text and has
no idea what a rupee is — which is why the calculations stayed testable and why
the move touched almost none of them.

## 2. Data flow

### Read path

```
boot ──▶ GET /data ──▶ { expenses: [...], loans: [...], ... }
                            │
                   store.setTable() × every table, THEN notify once
                            │
                            ▼
           useSyncExternalStore, one subscription per table
                            │
                            ▼
              useExpenses() / useDashboardData() / …
                            │
                 pure finance functions ──▶ rendered figures
```

Nothing renders before the fetch lands — `BootGate` holds the app on a spinner.
Showing a dashboard of zeros while a request is in flight would state a net
worth of ₹0, and a reader has no way to tell that from a wiped database.

**One request for everything**, because everything is small and because
seventeen per-table requests would be seventeen chances to render real income
against zero spending. The store fills every table and then notifies once, so no
subscriber can observe a half-loaded balance sheet — the atomicity the old
`useLiveQuery` was carefully written to preserve is now structural rather than
careful.

### Write path

```
page ──▶ lib/db/repository ──▶ POST /data/write ──▶ D1 (one transaction)
                                      │
                           accepted?  │ yes
                                      ▼
                        store applies it, notifies subscribers
                                      │
                                      ▼
                            every screen showing that table
```

Confirmed, not optimistic. The round trip is the cost; the benefit is that a
figure on screen is a figure in the database.

## 3. Folder structure

```
PaisaTrack/
├── docs/                      PRD, Architecture, Rules, Design, Memory
├── data-repo/                 Staged for copying into paisatrack-data
├── e2e/                       Playwright specs (production build)
├── tests/                     Vitest unit specs
├── scripts/
│   ├── gen-icons.mjs          PWA icons generated from scratch, no deps
│   ├── gen-vapid.mjs          Web-push keypair, run once
│   ├── vendor-ocr.mjs         Copies the OCR engine out of node_modules
│   └── fetch-rates.mjs        Monthly MCLR refresh, fails quietly
├── public/                    Icons, favicon
│   ├── push-sw.js             Push handlers, imported into the generated SW
│   └── tesseract/             Vendored OCR engine (gitignored, built)
├── worker/                    OPTIONAL Cloudflare Worker — its own npm project
│   ├── src/index.ts             /ocr, /push/*, daily cron
│   └── README.md                Deploy guide, quotas, what the server learns
├── .github/workflows/         deploy · ci · refresh-rates
└── src/
    ├── lib/
    │   ├── finance/           ◀── PURE. No React, no DB, no network.
    │   │   ├── money.ts         Integer paise, Indian formatting
    │   │   ├── dates.ts         Billing cycles, due dates, FY
    │   │   ├── emi.ts           EMI, amortization, prepayment
    │   │   ├── creditCard.ts    ADB interest ledger, MAD, payoff
    │   │   ├── salary.ts        CTC → in-hand, income tax
    │   │   ├── bills.ts         Recurring bills, electricity
    │   │   ├── cardState.ts     Resolver: ledger vs statements
    │   │   ├── loanState.ts     Resolver: payments vs schedule
    │   │   ├── cash.ts          Cash/bank projection and reconciliation
    │   │   └── dashboard.ts     Derived aggregates
    │   ├── db/
    │   │   ├── repository.ts    THE ONLY WRITE PATH → the server
    │   │   ├── legacy.ts        Reads the OLD IndexedDB, migration only
    │   │   └── seed.ts          Sample data, one batch
    │   ├── store/records.ts     In-memory records, filled from the server
    │   ├── server/config.ts     Worker URL and token (localStorage)
    │   ├── backup/payload.ts    The JSON backup file format
    │   ├── push/                Reminder subscriptions — uploads dates only
    │   ├── import/
    │   │   ├── tokens.ts        Indian dates and amounts (pure)
    │   │   ├── statement.ts     Text -> transactions (pure)
    │   │   ├── detect.ts        Document type and CAS holdings (pure)
    │   │   ├── pdf.ts           Lazy pdf.js, column-preserving extraction
    │   │   └── index.ts         File -> reviewable candidates
    │   ├── validation.ts        Zod schemas for anything imported
    │   ├── motion.ts            Spring integrator, reduced-motion guard
    │   └── utils.ts             cn(), humanise()
    ├── components/
    │   ├── ui/index.tsx         shadcn-pattern kit on Radix
    │   ├── icons.tsx            Phosphor, aliased to app names
    │   ├── charts.tsx           Recharts (lazy chunk)
    │   ├── chartPalette.tsx     Palette only — no Recharts import
    │   ├── LazyCharts.tsx       Suspense wrappers
    │   ├── motion.tsx            TiltCard, Magnetic, Reveal, SpringBar
    │   └── layout/              AppShell, nav model, SyncIndicator
    ├── pages/                   One file per screen
    ├── routes/router.tsx        Typed route tree
    ├── hooks/useData.ts         Live queries
    ├── stores/ui.ts             Theme, palette, selected month
    └── types/index.ts           Domain types
```

### The layering rule

```
pages ──▶ components ──▶ hooks ──▶ lib/db ──▶ Dexie
   │                        │
   └────────────────────────┴──▶ lib/finance  (pure, imports nothing above it)
```

`lib/finance` must never import from `components`, `pages`, `hooks` or `lib/db`.
That is what makes it testable without a browser, and it is why 309 unit tests
run in seven seconds.

## 4. Stack and why

| Layer | Choice | Why this one |
| --- | --- | --- |
| Build | Vite 8 (Rolldown) | 1.5s production build. Rolldown wants `manualChunks` as a function. |
| UI | React 19 | Ecosystem. StrictMode double-effects caught two real bugs. |
| Language | TypeScript 7 | `baseUrl` is removed; `typescript-eslint` does not support it yet (see Rules). |
| Routing | TanStack Router, code-based | Fully typed `to=`. A helper function erases path literals, so routes are declared one by one. |
| State | Zustand | UI state only. Domain state lives in Dexie. |
| Data store | Cloudflare D1, via the Worker | SQLite at the edge, free tier, no card. One table of JSON text — see §5. |
| Styling | Tailwind v4 | CSS-variable theming; no runtime CSS-in-JS. |
| Components | Radix + shadcn patterns | Copied in, owned here. Compatible with [21st.dev](https://21st.dev). |
| Icons | Phosphor | Six weights, and a real `CurrencyInr` glyph. |
| Charts | Recharts, lazy | 418 kB — deferred until a chart renders. |
| PDF reading | pdf.js, lazy | Extraction, not OCR — portal statements have a real text layer. Loaded only when a PDF is picked. |
| Spreadsheets | fflate + DOMParser | Hand-rolled XLSX reader. npm `xlsx` 0.18.5 carries an unpatched prototype-pollution CVE; fflate was already a dependency. |
| OCR | tesseract.js, self-hosted | Scans only, offered not automatic. Served from our own origin — the CDN default would have needed `script-src` for a third party. See Rules §4.6. |
| Server | Cloudflare Workers, free plan | Holds the records, plus OCR and push. No card. Required — there is no local copy. |
| Money | big.js | Never float. See Rules. |
| Validation | Zod | Everything crossing the trust boundary. |
| PWA | vite-plugin-pwa / Workbox | Precache everything the build emits, so the whole app works offline from the first visit. |
| Tests | Vitest + Playwright | Unit for the engine, e2e against the production build. |
| Lint | oxlint | Native TS/TSX, no TypeScript peer coupling. |

## 5. Database

### Schema

One table. The record is stored as the JSON text the client sent.

```sql
CREATE TABLE records (
  id         TEXT PRIMARY KEY,
  tbl        TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data       TEXT NOT NULL      -- the record, verbatim
);
CREATE INDEX idx_records_tbl ON records(tbl);
```

A column per field was rejected, and the reason is the Worker's 10ms CPU budget:
a normalised schema means parsing every incoming record and re-serialising every
outgoing one, which is real CPU spent re-deriving something the client already
had in the right shape. Opaque text means a read is assembled by **string
concatenation** — the `data` column is already valid JSON, so the response is
built by joining rows with commas. Nothing is parsed; nothing is stringified.

The trade is that the server cannot validate or query inside a record. That is
acceptable because there is one writer, it validates with Zod before sending,
and every figure is computed on the device. This is storage, not a domain model.
**If a second user or a server-side report ever appears, this is the first
decision to revisit.**

`ensureSchema()` runs `CREATE TABLE IF NOT EXISTS` before each request rather
than requiring a migration step during setup — one fewer thing to get wrong in
the README, and D1 makes it cheap.

### No tombstones

A delete is `DELETE FROM records`. Soft deletes existed so a deletion could
propagate through sync and beat a stale edit from another device; with one
authoritative copy there is no stale edit to beat.

### Money

**Every monetary value is an integer number of paise.** ₹1,234.56 is `123456`.
Integer addition is exact to `Number.MAX_SAFE_INTEGER` (~₹90 lakh crore).
Anything that multiplies or divides goes through big.js. This survived the move
untouched: paise travel as JSON integers and come back as JSON integers.

## 6. Performance architecture

| Technique | Where | Effect |
| --- | --- | --- |
| Route-level code splitting | `routes/router.tsx` | 10 page chunks, 3–7 kB gzipped each |
| Vendor chunk splitting | `vite.config.ts` | `react`, `db`, `vendor-github`, `vendor-csv`, `vendor-validation` — only vendors with **several** importers |
| Natural splitting for single-importer vendors | `vite.config.ts` | Recharts, jsPDF, html2canvas and canvg are deliberately *not* grouped; see `Memory.md` §9 for the 344 kB regression that grouping caused |
| Preload links filtered | `build.modulePreload.resolveDependencies` | Dynamic-only chunks are kept out of `index.html` |
| Lazy chart loading | `LazyCharts.tsx` | 413 kB deferred past first paint, and not mounted until the chart is within 400 px of the viewport |
| Lazy Octokit | `github/client.ts` | 105 kB never loaded without sync |
| Lazy jsPDF | `Reports.tsx` | 733 kB only on PDF export |
| Lazy pdf.js | `import/pdf.ts` | 421 kB plus a worker, only when a statement PDF is picked |
| Precache everything | Workbox config | 2.38 MB, so every page works offline from the first visit |
| ETag conditional polling | `github/client.ts` | 304s cost no quota |
| Atomic dashboard read | `useData.ts` | One IndexedDB round trip, not twelve |
| Memoised resolvers | `useMemo` on card/loan state | The ledger walks days; it must not re-run per render |
| Debounced search | `Expenses.tsx` | Filtering 64+ rows on every keystroke |
| Progressive list rendering | `Expenses.tsx` | Renders a growing window (100 rows, extended by an IntersectionObserver) rather than 1,000 at once. Not true virtualisation — rows are not recycled — and the other list pages do not use it yet. |

## 7. Statement import

A file goes in; reviewable candidates come out. Nothing reaches the database
without the user ticking it, because a parser working across a dozen bank
layouts will misread some of them and a wrong row in someone's finances is
worse than a missing one.

```
file ──▶ sniff the BYTES, not the extension
          │
          ├─ PDF ──▶ pdf.ts: extract text, rebuilding each page as
          │            fixed-width lines so column positions survive
          │            │
          │            └─ no text layer? ──▶ NeedsOcr ──▶ offer, don't act
          │                                    │
          │                                    └─ ocr.ts (tesseract, local)
          ├─ XLSX / HTML-table .xls / CSV ──▶ spreadsheet.ts ──▶ padded lines
          │
          └──────────────▶ detect.ts  (BANK | CARD | UPI | CAS)
                                │
                    CAS ────────┴──────── everything else
                     │                         │
                 parseCas()            extractTransactions()
                     │                         │
                     └──────────▶ dedupe ──▶ REVIEW SCREEN ──▶ repository
```

Three decisions carry most of the weight:

**Extraction, not OCR, by default.** Indian bank, card and CAS statements
downloaded from a portal are digitally generated and carry a real text layer.
The characters are already in the file, exact, with coordinates. OCR is both
heavier and less accurate; reaching for it first would be slower *and* worse.
It exists only for a photograph or a scan, it is offered rather than run, and
everything it produces is forced to LOW confidence.

**Direction is decided by a ranked hierarchy, and the order is load-bearing.**
Running-balance arithmetic first (previous balance − amount = this balance),
then which column the figure was printed in, then Dr/Cr wording. The column
signal is the strongest-looking one and it is *second*, because OCR collapses
runs of whitespace and destroys it — while the balance check is arithmetic and
survives a scan intact. `ocr-output.test.ts` pins this against literal
tesseract output.

**Bytes over extensions.** Half the `.xls` files Indian bank portals emit are
HTML tables. Excel opens them; every real XLSX parser rejects them. Trusting
the extension would mean telling someone their perfectly good statement is
corrupt.

Re-importing an overlapping period is safe: rows are fingerprinted on
date + amount + normalised description, and anything already stored arrives
pre-unticked rather than silently dropped, so the user can see what was
skipped.

## 8. The server

PaisaTrack is no longer local-first. Until October 2026 the records lived in
IndexedDB on whichever device typed them, with an optional GitHub sync to
reconcile devices; they live in a Cloudflare D1 database in the user's own
account now, and the app reads and writes it directly.

**What that bought:** one copy of the truth. The old design's problem was never
offline support, which it did well — it was that a phone and a laptop held
different data and neither was complete, and the machinery to reconcile them
(last-write-wins, tombstones, a deviceId tiebreaker, a conflict table) was the
most intricate code in the project and existed solely to paper over having two
copies. One writer and one database needs none of it. It was all deleted, along
with Dexie, which left the bundle entirely.

**What it cost:** offline. Nothing is cached on the device, so with no
connection there is nothing to show — chosen knowingly over a cache that can
disagree with the thing it is caching.

```
  Settings ──▶ URL + token in _settings (IndexedDB)
                     │
     ┌───────────────┴───────────────┐
     │                               │
  OCR (opt-in)                  Reminders (opt-in)
     │                               │
  one statement,                 a list of DATES
  on one button press            no amounts, no payees
     │                               │
     ▼                               ▼
  POST /ocr ──▶ vision model    POST /push/subscribe ──▶ KV
  transcription back                   │
     │                            daily cron ──▶ bodiless push
     ▼                                              │
  the SAME parser that reads             SW shows a generic line;
  a text-layer PDF, balance              the app fills in the detail
  check and all                          from the local database
```

**Why it fits on the free plan.** Workers Free allows **10ms of CPU** per
request — a budget for time spent executing, not a speed limit that can be
traded for patience. Running Tesseract there is impossible at any speed. So
every path is I/O-bound by construction: the browser base64-encodes the image
before upload (touching a megabyte server-side would blow the budget alone),
inference happens on Cloudflare's GPUs through a binding, and a push is one
ECDSA signature plus a POST.

**Why the model only transcribes.** A vision model asked for structured
transactions returns well-formed JSON containing invented figures — a worse
failure than Tesseract's, because a plausible wrong number survives a glance
and a garbled one does not. So the Worker's prompt asks only for a
transcription, and the text goes through `buildResult` exactly like every other
source. That means the running-balance check runs over it unchanged, and it
does not care whether a human, Tesseract or an LLM produced the number: an
invented amount fails to reconcile with the balance printed beside it and gets
flagged.

**Why the push is empty.** A payload would have to be encrypted by the sender,
and to encrypt it the Worker would first have to *hold* it — the amount, the
payee, the account. A bodiless push is a legal push: it wakes the service
worker, which shows "a payment is due", and the app supplies the detail
locally after the tap. Sending nothing is both simpler than and strictly more
private than sending something encrypted.

**Why it is a separate npm project.** Importing `worker/src` into the app's
TypeScript program would pull `@cloudflare/workers-types` globals — `Ai`,
`KVNamespace`, a different `fetch` — into the type space of a browser app that
is not a Worker. It has its own tsconfig, its own vitest, and its own CI steps.

## 9. What this architecture cannot do

Stated plainly, because a reader will otherwise ask:

- **No server-side validation or business logic.** The Worker (§8) stores and
  returns opaque text. It has no notion of an account, no permission model
  beyond one shared token, and no idea what a rupee is — every figure the app
  reports is computed on the device.
- **No offline use.** Nothing is cached locally; with no connection there is
  nothing to show. Given up deliberately in exchange for one copy of the truth
  (PRD §5.2).
- **No version history.** D1 holds the current value of each record, not its
  past. A backup file from Settings is the only way back.
- **No authentication.** The device is the trust boundary. Anyone with the
  unlocked device has the data, exactly as with a notes app.
- **No multi-user isolation**, because there is one user.
- **No uptime monitoring** of our own; availability is GitHub Pages' availability.

See `docs/Rules.md` §7 for the full applicability matrix.
