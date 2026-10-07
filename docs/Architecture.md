# PaisaTrack — Architecture

**Last updated:** 2026-10-06

---

## 1. The shape of it

There is no backend. The app is a static bundle on a CDN, a database in the
browser, and one JSON file in a private git repo.

```
┌──────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                             │
│                                                                      │
│   React 19 ── TanStack Router ── Zustand (UI state only)             │
│        │                                                             │
│        │ reads (always, synchronously from memory)                   │
│        ▼                                                             │
│   ┌──────────────────┐        ┌────────────────────────────────┐    │
│   │  Dexie/IndexedDB │◀──────▶│  lib/finance/*  (pure)         │    │
│   │  SOURCE OF TRUTH │  data  │  no React, no DB, no network   │    │
│   └────────┬─────────┘        └────────────────────────────────┘    │
│            │ writes go through lib/db/repository.ts ONLY             │
│            ▼                                                         │
│   ┌──────────────────┐                                               │
│   │   sync queue     │  debounced 3s, coalesced into one commit      │
│   └────────┬─────────┘                                               │
└────────────┼─────────────────────────────────────────────────────────┘
             │  Octokit (lazy-loaded; only if a token exists)
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  GITHUB (free forever)                                               │
│                                                                      │
│   paisatrack-app  (PUBLIC)      paisatrack-data  (PRIVATE)           │
│   ├── Pages = static host       └── data.json                        │
│   │   (Fastly CDN)                  ├── one commit per sync          │
│   └── Actions: build, deploy,       ├── full version history         │
│       monthly rate refresh          └── snapshots/ nightly           │
└──────────────────────────────────────────────────────────────────────┘
```

### Why this shape

**Reads never touch the network.** That is what makes the app feel instant and
work offline. It also means every derived figure is a pure function over arrays
already in memory — the whole dashboard recomputes in microseconds.

**Writes land locally first, then queue.** The UI never waits on GitHub. If sync
is off, broken, or offline, nothing changes about how the app behaves.

**Every write is a commit.** The sync history *is* the backup history. Restore
from any point in the git log.

## 2. Data flow

### Read path

```
Dexie table ──▶ useLiveQuery ──▶ useDashboardData (ONE atomic query)
                                        │
                                        ▼
                          resolveAllCardStates / resolveAllLoanStates
                                        │
                                        ▼
                     monthSnapshot · upcomingDues · debtOverview · netWorth
                                        │
                                        ▼
                                    components
```

Two rules this enforces:

1. **The dashboard reads atomically.** One `useLiveQuery` across twelve tables,
   not twelve separate ones. Separate queries resolve independently, so the page
   renders real income against zero spending for a frame — a half-loaded balance
   sheet is wrong, not merely incomplete.
2. **One resolver per entity.** `cardState.ts` and `loanState.ts` are the single
   source of "what does this actually owe". Every screen reads from them, so no
   two places can quote a different balance for the same card.

### Write path

```
component ──▶ lib/db/repository.ts ──▶ Dexie table
                      │                      │
                      │                      └──▶ stamps updatedAt + deviceId
                      └──▶ _syncQueue ──▶ emitChange() ──▶ sync engine (debounced)
```

Nothing writes to a Dexie table directly except the seeder and the sync applier,
both of which pass `skipSync` deliberately. Deletes are **soft** — `deletedAt` is
set — so a deletion travels to the other device instead of being resurrected by
its stale copy.

## 3. Folder structure

```
PaisaTrack/
├── docs/                      PRD, Architecture, Rules, Design, Memory
├── data-repo/                 Staged for copying into paisatrack-data
├── e2e/                       Playwright specs (production build)
├── tests/                     Vitest unit specs
├── scripts/
│   ├── gen-icons.mjs          PWA icons generated from scratch, no deps
│   ├── vendor-ocr.mjs         Copies the OCR engine out of node_modules
│   └── fetch-rates.mjs        Monthly MCLR refresh, fails quietly
├── public/                    Icons, favicon
│   └── tesseract/             Vendored OCR engine (gitignored, built)
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
    │   │   ├── schema.ts        Dexie schema + versions
    │   │   ├── repository.ts    THE ONLY WRITE PATH
    │   │   └── seed.ts          Sample data, one transaction
    │   ├── sync/
    │   │   ├── merge.ts         Conflict rules (pure, tested)
    │   │   └── engine.ts        Background push/pull
    │   ├── github/client.ts     Octokit wrapper, lazy-loaded
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
| Local store | Dexie | Live queries, compound indexes, schema versioning. |
| Sync | Octokit, lazy | ~105 kB, and most sessions never configure sync. |
| Styling | Tailwind v4 | CSS-variable theming; no runtime CSS-in-JS. |
| Components | Radix + shadcn patterns | Copied in, owned here. Compatible with [21st.dev](https://21st.dev). |
| Icons | Phosphor | Six weights, and a real `CurrencyInr` glyph. |
| Charts | Recharts, lazy | 418 kB — deferred until a chart renders. |
| PDF reading | pdf.js, lazy | Extraction, not OCR — portal statements have a real text layer. Loaded only when a PDF is picked. |
| Spreadsheets | fflate + DOMParser | Hand-rolled XLSX reader. npm `xlsx` 0.18.5 carries an unpatched prototype-pollution CVE; fflate was already a dependency. |
| OCR | tesseract.js, self-hosted | Scans only, offered not automatic. Served from our own origin — the CDN default would have needed `script-src` for a third party. See Rules §4.6. |
| Money | big.js | Never float. See Rules. |
| Validation | Zod | Everything crossing the trust boundary. |
| PWA | vite-plugin-pwa / Workbox | Precache everything the build emits, so the whole app works offline from the first visit. |
| Tests | Vitest + Playwright | Unit for the engine, e2e against the production build. |
| Lint | oxlint | Native TS/TSX, no TypeScript peer coupling. |

## 5. Database

### Schema versions

| Version | Change |
| --- | --- |
| 1 | Core tables, sync bookkeeping, settings |
| 2 | `cardTxns`, `cardPayments` — transaction-level card ledger |

Dexie carries older data forward untouched. Adding a table is a new `version()`
block, never an edit to an existing one.

### Indexes

Chosen from actual query shapes, not guessed:

| Table | Index | Query it serves |
| --- | --- | --- |
| `expenses` | `[category+date]` | Dashboard category rollups for a month |
| `expenses` | `date`, `paymentMethod`, `creditCardId` | Filters |
| `cardTxns` | `[cardId+date]` | Ledger walks one card in date order |
| `cardPayments` | `[cardId+date]` | Same |
| `budgets` | `[month+category]` | Budget progress lookup |
| `billEntries` | `billingMonth`, `dueDate`, `status` | Monthly view, upcoming dues |
| all | `updatedAt` | Sync watermarking |

### Money

**Every monetary value is an integer number of paise.** ₹1,234.56 is `123456`.
Integer addition is exact to `Number.MAX_SAFE_INTEGER` (~₹90 lakh crore).
Anything that multiplies or divides goes through big.js.

## 6. Sync protocol

```
PULL   GET /repos/{owner}/{repo}/contents/data.json   If-None-Match: <etag>
       └─ 304 → nothing changed, costs no rate limit
       └─ 200 → parse, merge, apply what is newer

PUSH   PUT /repos/{owner}/{repo}/contents/data.json   { content, sha }
       └─ 409 → someone else committed; re-pull, merge, retry (max 3)
```

**Conflict resolution** — last-write-wins on `updatedAt`, with `deviceId` as a
deterministic tiebreaker so both devices independently reach the same answer. A
tombstone beats a live record at the same timestamp.

**Deviation from the original brief:** reads use the Contents API rather than
`raw.githubusercontent.com`, because that host cannot serve a private repo with
a bearer token. The Contents API supports conditional requests, so 30-second
polling is effectively free.

## 7. Performance architecture

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

## 8. Statement import

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

## 9. What this architecture cannot do

Stated plainly, because a reader will otherwise ask:

- **No server-side anything** — no server-side validation, no server-side
  permission checks, no inbound rate limiting, no server-side caching, no load
  balancer, no connection pooling. There is no server.
- **No authentication.** The device is the trust boundary. Anyone with the
  unlocked device has the data, exactly as with a notes app.
- **No multi-user isolation**, because there is one user.
- **No uptime monitoring** of our own; availability is GitHub Pages' availability.

See `docs/Rules.md` §7 for the full applicability matrix.
