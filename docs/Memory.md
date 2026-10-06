# PaisaTrack — Memory

Hard-won knowledge from building this. Read before changing anything listed here;
most entries exist because something looked right, typechecked, passed tests, and
was still wrong.

**Last updated:** 2026-10-06

---

## 1. Environment

### Node had to be installed

This machine had no Node. v24.21.0 LTS was installed **portably** to
`C:\Users\<you>\nodejs` (zip from nodejs.org, SHA-256 verified against
`SHASUMS256.txt`) and appended to the user PATH via `HKCU\Environment`. No admin,
no MSI, no system-wide change beyond that one PATH entry.

### Git Bash gotchas on this machine

- **MSYS mangles `/v`-style flags.** `reg query "HKCU\Environment" /v Path`
  silently fails because MSYS rewrites `/v` into a path. Fix:
  `export MSYS2_ARG_CONV_EXCL="*"`.
- **Node cannot read MSYS paths.** `node -e "require('/tmp/x.json')"` fails —
  `/tmp` is an MSYS path, and `node.exe` is a Windows binary. Use Windows paths
  or the scratchpad directory.
- **Heredocs break on long TS/TSX content.** Writing large source files via
  `cat > file <<'EOF'` failed on apostrophes. Use the `Write` tool for source
  files; heredocs are fine for YAML and short configs.
- **A doubled backslash collapses to one before the shell runs.** Even inside a
  quoted heredoc, `"\\n"` in a Node one-liner arrives as `"\n"`, so the script
  writes a *real* newline where the source should have held the two characters
  `\` and `n`. This corrupted three files before it was spotted: a literal NUL
  byte in a `vite.config.ts` comment (from `"\\0vite/"`), a Playwright regex
  that became `//reports$/`, and a test file full of raw control bytes. The
  symptom is a file `grep` starts calling "binary". Build the backslash from
  its code point instead — `String.fromCharCode(92) + 'u0000'` — or use the
  `Write`/`Edit` tools, which are not subject to it.
- **The PowerShell tool does not spawn here** (`EUNKNOWN: uv_spawn`). Everything
  went through Git Bash.
- **The launcher does not inherit PATH changes.** `.claude/launch.json` points at
  `C:/Users/<you>/nodejs/node.exe` directly, with forward slashes —
  backslashes in JSON get eaten as escapes.

---

## 2. Toolchain surprises

| What | Reality | Consequence |
| --- | --- | --- |
| **TypeScript 7** | `baseUrl` is **removed** | Path aliases resolve relative to `tsconfig.json`; drop `baseUrl` entirely |
| **TypeScript 7** | `typescript-eslint` **refuses to run** ([#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)) | Lint with oxlint. Do not downgrade TS to appease it. |
| **Vite 8** | Uses Rolldown | `manualChunks` must be a **function**; an object throws |
| **Vite 8** | A static re-export from a lazily-imported module pulls it back into the static graph | `chartPalette.tsx` exists so `LazyCharts` can re-export the palette without dragging 418 kB of Recharts into the initial bundle |
| **Vite 8** | `manualChunks` can *capture Vite's own `__vitePreload` helper* into a vendor chunk, and then every chunk that performs a dynamic import statically imports that vendor chunk | See §9. Do not create a manual chunk for a vendor with a single lazy importer. |
| **Vite 8** | Preload links in `index.html` are emitted for chunks reached only through a dynamic import | Filter them with `build.modulePreload.resolveDependencies`, keying on `hostType === 'html'` |
| **Recharts 3** | `labelFormatter` receives `ReactNode`, not `string` | Wrap in `String(label)` |
| **Zod 4** | `z.string().email()` is deprecated in favour of `z.email()` | — |

---

## 3. Bugs that typechecked and passed tests

These are the reason "it compiles" is not evidence.

### 3.1 Every animated figure read ₹0 in a background tab

Browsers pause `requestAnimationFrame` in a hidden tab. The count-up animation
was the **only** path by which the real value reached the DOM, so a backgrounded
dashboard showed `₹0` for net worth until you looked at it.

**Fix:** the animation is now a pure enhancement. If `document.hidden`, or
`prefers-reduced-motion`, or frames simply never arrive (there is a
`setTimeout` backstop), the true value is set immediately.

**Rule it generalises to:** never let an animation be the only path by which a
value arrives.

### 3.2 The command palette silently refused to navigate

`<CommandPalette />` was rendered as a **sibling** of `<RouterProvider>` in
`main.tsx`. `useNavigate()` therefore had no router context and returned a
function that did nothing — no error, no warning. The palette opened, the item
highlighted, the dialog closed, and the URL never changed.

**Fix:** the overlays moved inside `AppShell` (the root route component).
`nav.ts` was extracted so `AppShell` and `CommandPalette` can share the nav model
without importing each other.

### 3.3 The dashboard rendered income against zero spending

Twelve separate `useLiveQuery` calls resolve independently. For a frame or two
the page showed real income and ₹0 spent — a *wrong* balance sheet, not an
incomplete one.

**Fix:** one atomic `useLiveQuery` across all twelve tables, plus an
`isLoading` gate that shows skeletons until the whole snapshot is in.

### 3.4 Dexie's transaction zone does not survive an async wrapper

Wrapping the seeder's writes in `db.transaction('rw', ..., async () => { await
bulkPut(...) })` broke silently — nothing was written, no error surfaced. Dexie
tracks transaction scope through its own promise zone, which a native `async`
helper function breaks.

**Fix:** call `db.table.bulkPut()` directly inside the transaction callback.

### 3.5 `new Date('YYYY-MM-DD')` parses as UTC

In `generateAmortization`, the first-EMI check compared
`dayOfMonthClamped(...)` (local midnight) against
`new Date(startDate).setHours(0,0,0,0)`. `new Date('2026-04-15')` is **UTC**
midnight, which in any timezone west of Greenwich is the 14th locally — shifting
the entire schedule by a month.

**Fix:** both sides go through `toDate()` (date-fns `parseISO`, which parses as
local). Verified by running the EMI suite under `TZ=America/New_York`.

### 3.6 A hook after an early return

`CardLedger` had a `useMemo` below `if (!hasActivity) return ...`. React throws
the moment a card gets its first transaction and the component takes the other
branch. Typechecks fine; unit tests never hit it.

**Fix:** moved above the return — and oxlint's `react-hooks/rules-of-hooks` was
added specifically so this class cannot recur.

### 3.7 The app detected the one catastrophe it exists to prevent, and continued

Found by a pre-publication audit. `testConnection` returned **`ok: true`** for a
**public** data repo, with the warning only in its `message` string:

```ts
message: repo.private
  ? `Connected as ${login}. ${owner}/${repo} is private — good.`
  : `Connected as ${login}. Warning: ... is PUBLIC. ... Make it private.`,
```

`Settings.tsx` gates on `res.ok` alone, so it saved the token and called
`reconfigure()` → `syncEngine.start()` → push. The banner also styles on
`result.ok`, so the words "your financial data would be visible to anyone"
rendered **inside a green success box with a tick**, next to a "Sync connected"
toast, while salary, card limits, balances and every expense row were committed
to a world-readable repo seconds later.

`repoPrivate` was returned by the function and **read by nothing** — three
definition sites, zero consumers. That is the tell: a field computed and never
consumed usually means a decision someone intended to make and did not.

**Fix:** a public repo is now `ok: false` — a refusal, with no override, because
making a repo private is one click and the leak is irreversible. `isRepoPrivate()`
re-checks on every engine start, so a repo made public *later* stops syncing
instead of continuing to push. Pinned by `tests/sync.visibility.test.ts`.

**Rule it generalises to:** if a check is worth performing, its result has to
change what the code *does*, not just what it says. A warning the caller cannot
act on is decoration.

### 3.8 A test that passed because of the date

`upcoming dues are ordered soonest first` scraped due badges from the whole
dashboard and asserted the sequence was monotonic. But the page has several
independent badge groups — the dues list, and one per card in the health panel.
Concatenating them is not a sorted sequence and never was. It passed for weeks
because the seeded dates happened to line the groups up, then failed the moment
"today" moved by five days.

**Fix:** scope the selector to `data-testid="upcoming-dues"`, and assert the
list is non-empty so a stale selector fails loudly rather than passing
vacuously.

**Rule:** a test that scrapes by text across a whole page is asserting on a
coincidence of layout. Scope to the thing under test, and make an empty match a
failure.

### 3.9 `Date.parse` accepts 31 April

Found by writing the first tests for `validation.ts`. `isoDateSchema` paired a
`YYYY-MM-DD` regex with `.refine(d => !Number.isNaN(Date.parse(d)))`, which
reads like a validity check and is not one:

| Input | `Date.parse` |
| --- | --- |
| `2026-13-01` | NaN — rejected |
| `2026-02-30` | **parses, as 2 March** |
| `2026-04-31` | **parses, as 1 May** |
| `2025-02-29` | **parses, as 1 March** |

Month overflow is caught; day overflow silently rolls forward. A spreadsheet
column exported as `31/04` would import, be stored verbatim as `2026-04-31`,
and then render and sort as May — a wrong date that never announces itself.
`validateCsvRows` had its own copy of the same check.

**Fix:** `isRealCalendarDate()` round-trips the components through
`Date.UTC` and compares. Both call sites use it, and the CSV path now reports
"is not a real date" rather than telling someone to use a format they already
used.

---

## 4. Finance engine: what the audit found

An adversarial audit confirmed **13 defects**, all now pinned in
`tests/finance.regressions.test.ts`. The ones worth remembering:

### 4.1 A payment dated on the statement date was counted twice

Payments are applied before the statement is cut, so such a payment already
reduces the billed balance. `paymentsBetween()` then used an **inclusive** lower
bound and counted it *again* as "paid by the due date" — marking a statement
₹15,000 short as PAID, granting a free interest-free period and skipping the
late fee.

**Fix:** the lower bound is exclusive of the statement date.

### 4.2 Carried transactions were silently dropped

`calculateStatementInterest` passed `from: previousStatementDate` to the ledger,
but the day loop only visits days ≥ `from` — so every carried transaction, which
by definition predates that date, never created a lot at all. The function
existed precisely to model those, and discarded them.

**Fix:** `from` is derived as the earliest of the previous statement date and
every supplied transaction date, plus a new `emitStatementsFrom` option so
widening the window does not emit intermediate statements that bill the interest
away early.

### 4.3 HDFC's 30% minimum-due formula replaced the standard one

Treated as a substitute rather than an additional floor, it silently dropped
100% of EMI and 100% of the overlimit amount from the minimum due.

**Fix:** `max(standard, alternate)`.

### 4.4 87A marginal relief was applied to the old regime

The marginal-relief proviso exists only under s.115BAC (new regime). The old
regime's 87A is a **hard cliff** at ₹5L. Applying relief understated old-regime
tax for incomes between ₹5,00,000 and ₹5,15,625.

### 4.5 Surcharge had no marginal relief at all

Crossing ₹50L by ₹2,000 would have cost over a lakh in surcharge.

### 4.6 Late fees attracted no GST

The fee was pushed onto the lot ledger but never into `feesThisCycle`, so the
next statement charged no 18% GST on it and treated it as 5%-rate residual
rather than a 100%-mandatory component of the minimum due.

### 4.7 Overpayment was stranded

An overpayment became a negative-balance lot that the accrual loop skipped
(`if (lot.balance > 0)`) and no later purchase ever consumed — so once revolving,
interest was charged on the gross spend rather than the net balance.

**Fix:** a single `creditBalance` number, spent by the next purchase.

---

## 5. Decisions and why

| Decision | Reasoning |
| --- | --- |
| **Contents API, not `raw.githubusercontent.com`** | That host cannot serve a *private* repo with a bearer token. The Contents API supports ETags, so a 304 costs no rate limit — polling every 30s is effectively free. |
| **`data.json` is pretty-printed** | Costs bytes, but makes the git diff of every sync readable. The backup history is the feature; an unreadable diff would waste it. |
| **Records sorted by id in the payload** | Stable ordering keeps diffs minimal. |
| **Soft deletes** | A hard delete cannot propagate; the other device resurrects it on the next pull. |
| **`deviceId` as tiebreaker** | Both devices must independently pick the *same* winner, or they never converge. Arbitrary but deterministic beats a coin flip. |
| **Two ways to describe a card** | Statement totals are what most people will use; the transaction ledger is for precision. `cardState.ts` resolves them so no screen can disagree. |
| **`loan.outstandingPrincipal` is never trusted** | A figure typed once that drifts the moment an EMI is paid. `loanState.ts` derives it from recorded payments, falling back to the schedule at today's date. |
| **HDFC's published ₹591.75 vs our ₹591.78** | Three paise of rounding in their illustration, not a method difference. The test asserts the exact ADB figure and documents the discrepancy. |
| **Seeded PRNG in `seed.ts`** | Sample data must look identical on every load, or screenshots and tests drift. |
| **Icons generated, not downloaded** | `gen-icons.mjs` hand-writes PNGs with `zlib`. No image dependency, no binary blobs to review. |

---

## 6. Testing lessons

- **Playwright isolates storage per test.** Explicitly deleting IndexedDB in a
  fixture was actively harmful: the delete *blocks* while the app holds the
  connection open, then fires after the reload and wipes data the test just
  wrote. Symptom was a seed that worked standalone and vanished under test.
- **Wait on the data, not a toast.** Sonner toasts auto-dismiss in ~4s, so
  asserting on one is a race. Assert on the figure that must change.
- **Assert on accessible names for anything responsive.** The sync label is
  `hidden lg:inline`; `getByText('Local only')` fails on mobile while
  `getByRole('button', { name: /Sync status: Local only/ })` passes everywhere.
- **`console.log` is swallowed by Vitest** unless you pass
  `--disable-console-intercept`. Essential when probing engine behaviour.
- **Check the overflow, do not eyeball it.** `document.documentElement.scrollWidth
  > clientWidth` found 57px of overflow that a cropped screenshot had hidden.

---

## 7. Known limitations

- **Service worker registration is unverified.** The embedded browser pane blocks
  it. The `sw.js` is valid JS, serves 200 with `text/javascript`, its precache
  manifest resolves to real files, and the webmanifest meets every installability
  requirement — but install-to-homescreen has not been exercised on a real device.
- **`vite preview` occasionally returns `ERR_NETWORK_CHANGED`** under Playwright.
  Transient; retries pass. `retries: 2` is set for CI.
- **The `Reminder` table exists but nothing writes to it.** Reminders are
  currently derived from due dates. Either wire it up or drop the table.

---

## 8. Numbers worth remembering

| | |
| --- | --- |
| Unit tests | 342 across 15 files, ~50s |
| E2E tests | 42 declared / 39 run (desktop + Pixel 7), ~44s |
| Finance engine coverage | 94% statements, 96% lines |
| Production build | ~1.5s |
| Initial JS (transferred) | **284 kB** across 16 files |
| Precache | 2.38 MB, 45 entries — full offline, deliberately over budget |
| Lighthouse (mobile) | **92 / 100 / 100 / 100** perf · a11y · best-practices · SEO |
| Core Web Vitals (mobile preset) | FCP 2.1 s · LCP 3.1 s · TBT 10 ms · CLS 0 |
| Deferred chunks | jsPDF 390 kB · html2canvas 195 kB · canvg 148 kB · Recharts 413 kB — all behind lazy routes, none named manual chunks |
| ₹1L at 43.2%, minimum only | 15 years, ₹2,12,990 interest |
| HDFC worked example | ₹15,000 × 45% × 32/365 = ₹591.78 |

---

## 9. The chunking bug that cost 344 kB on every page load

Worth its own section, because every symptom pointed somewhere else and the fix
is counter-intuitive: **deleting two `manualChunks` rules made the app faster.**

Lighthouse reported 372 kB of unused JavaScript on the dashboard, naming
`vendor-pdf` (229 kB transferred) and `vendor-charts` (115 kB). Both *looked*
correctly lazy: `Reports.tsx` imports jsPDF inside `exportPDF()`, Reports itself
is a `React.lazy` route, and Recharts sits behind `LazyCharts`. The service
worker was not precaching them either.

The waterfall gave it away — both were fetched in the **first request burst, at
High priority**, and `dist/index.html` was emitting `<link rel="modulepreload">`
for them. Two separate causes, stacked:

1. **Vite preloads chunks reached only through dynamic imports.** Fixed with
   `build.modulePreload.resolveDependencies`, filtering on `hostType === 'html'`.
2. **The real one.** `AppShell-*.js` contained a genuine static
   `import { r } from "./vendor-pdf-*.js"`. Minified `r` turned out to be
   `__vitePreload` — Vite's *own dynamic-import helper*. Rolldown had placed
   that helper inside `vendor-pdf`, so every chunk performing any dynamic import
   had to statically import 780 kB of jsPDF to reach it.

Returning `'vite-helpers'` for `\0vite/preload-helper.js` from `manualChunks`
did not work: the branch fired, and Rolldown placed the helper in `vendor-pdf`
anyway. What did work was **removing the `vendor-pdf` and `vendor-charts` groups
entirely**. Both had exactly one importer, and that importer was already lazy —
so natural splitting isolates them perfectly well, while forcing them into
shared vendor chunks was what let the helper get entangled in the first place.

**Rule: a manual chunk is for a vendor with several importers. A heavy vendor
with one lazy importer should ride its parent chunk.**

A third fix compounded it: `LazyCharts` mounted its `React.lazy` components as
soon as they rendered, so a chart below the fold still cost 116 kB during load.
They now mount on an `IntersectionObserver` with a 400 px margin. Printing and
PDF export cannot scroll, so both call `mountAllCharts()` — `beforeprint` for
Ctrl-P, and `exportPDF` awaits it before html2canvas captures the DOM, or the
PDF would contain skeletons.

Net: initial JS 745 kB → 284 kB, LCP 5.2 s → 3.1 s, TBT 330 ms → 10 ms,
Lighthouse performance 65 → 92.
