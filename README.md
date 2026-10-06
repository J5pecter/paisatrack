# PaisaTrack

A personal finance tracker for India. Salary, credit cards, EMIs, bills and
expenses — local-first, installable, and synced through a private GitHub repo
you own.

Runs at **₹0 forever**. No server, no managed database, no credit card at any
step. The only infrastructure is GitHub's own permanently free tier.

---

## Why this exists

Most finance apps either want a subscription or want your bank credentials.
PaisaTrack wants neither. Everything lives in your browser's IndexedDB; if you
turn sync on, a copy also lives in a private repo you control. Every save is a
git commit, so your complete history is recoverable from the log.

It is built around the parts of Indian personal finance that actually cost
people money:

- **Credit card interest computed properly.** Average Daily Balance, per-lot,
  with the retroactive loss of the interest-free period modelled correctly —
  the thing that turns a ₹15,000 purchase into an interest charge dated from
  the day you made it rather than the day of the statement.
- **The minimum-due trap, quantified.** ₹1,00,000 at 43.2% paying only the
  minimum is 15 years and ₹2.1 lakh of interest. The app shows you that number.
- **Avalanche vs snowball**, simulated side by side on your real balances.
- **CTC → in-hand**, and a new-vs-old tax regime comparison for FY 2025-26
  including surcharge, cess, the 87A rebate and marginal relief.
- **Amortization and prepayment maths**, with rates pre-filled from every major
  Indian lender.

---

## Quick start

```bash
npm install
npm run dev
```

The app opens at `http://localhost:5173/paisatrack/`. Click **Load sample data**
on the first run to see it populated.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR |
| `npm run lint` | oxlint — see [LINTING.md](LINTING.md) |
| `npm run build` | Typecheck, then production build |
| `npm run test` | Unit tests |
| `npm run test:e2e` | End-to-end tests against the production build |
| `npm run test:all` | Lint, typecheck, unit and e2e |
| `npm run coverage` | Tests with coverage for the finance engine |
| `npm run typecheck` | TypeScript only |
| `npm run refresh-rates` | Pull lender rates from the MCLR disclosure |

---

## Deploying it (free, ~10 minutes)

### 1. The app repo — public

GitHub Pages is only free for public repos. This repo holds no personal data —
`npm run scan:secrets` checks that before every push, and CI runs it too.

**Set the commit identity first.** Git otherwise uses your global config, and
whatever name and email that holds end up in every commit object, readable
through the web UI, the API and `git log`, and scraped for addresses. It is
baked into the commit SHA, so removing it later means rewriting history — by
which point GitHub's cached objects and any fork already have it.

```bash
git init -b main

# Use your GitHub handle and the noreply address from
# GitHub -> Settings -> Emails ("Keep my email addresses private").
git config user.name  "<your-github-handle>"
git config user.email "<id>+<your-github-handle>@users.noreply.github.com"

git add -A && git commit -m "PaisaTrack"
gh repo create paisatrack --public --source=. --push
```

Then **Settings → Pages → Source: GitHub Actions**. Pushing to `main` builds and
deploys automatically. The workflow derives the base path from the repo name, so
renaming the repo re-points the asset URLs automatically. The one exception is a
repo named `<you>.github.io`, which Pages serves from the domain root rather
than a subpath — that needs `VITE_BASE_PATH: /` instead.

Your app will be at `https://<you>.github.io/paisatrack/`.

### 2. The data repo — private

```bash
gh repo create paisatrack-data --private
```

Copy `data-repo/` from this repo into it — it contains a README and an optional
nightly snapshot workflow.

**This repo must be private.** It holds your salary and your balances.
PaisaTrack *refuses* to connect to a public repo and re-checks on every start,
so a repo made public later stops syncing rather than quietly continuing to
push. Check it yourself anyway.

### 3. The token

GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → Generate new token.

- Repository access: **Only select repositories** → `paisatrack-data`
- Permissions: **Contents → Read and write**

Paste it into PaisaTrack → Settings → GitHub sync → Connect.

The token is stored in this browser's IndexedDB and is only ever sent to
`api.github.com`. It is never logged, never put in a URL, and never sent
anywhere else.

---

## How sync works

```
   Your device                              GitHub (free forever)
┌─────────────────────┐                 ┌──────────────────────────┐
│  Dexie / IndexedDB  │  all reads      │  paisatrack-data (private)│
│  ← source of truth  │ ───────────────▶│                           │
│                     │                 │   data.json               │
│  writes land here   │   push: commit  │   ├── one commit per sync │
│  first, instantly   │ ───────────────▶│   ├── full version history│
│                     │                 │   └── restore from any sha│
│  sync engine        │   pull: ETag    │                           │
│  (background)       │ ◀───────────────│   304 when unchanged →    │
└─────────────────────┘   every 30s     │   costs no rate limit     │
                                        └──────────────────────────┘
```

Reads never touch the network, which is what makes the app feel instant and
work offline. Writes land in IndexedDB first and are then queued; the sync
engine coalesces a burst of edits into a single commit a few seconds later.

**Conflict resolution** is last-write-wins on `updatedAt`, with `deviceId` as a
deterministic tiebreaker so both devices independently reach the same answer.
Deletions are tombstones, so deleting on one device is never undone by the
other's stale copy. On a write collision GitHub returns 409, and the engine
re-pulls, merges and retries.

**One deliberate deviation from the brief:** reads go through the Contents API
rather than `raw.githubusercontent.com`. That host cannot serve a *private* repo
with a bearer token. The Contents API supports conditional requests, so an
unchanged poll returns 304 and costs nothing against the 5,000/hour limit —
30-second polling is effectively free. Real usage is roughly 100 requests a day.

Sync is entirely optional. With no token the app is a complete, working,
local-only finance tracker.

---

## Two ways to describe a card

You can tell PaisaTrack about a card either way, per card:

1. **Type the totals off your statement.** Simple, and what most people want.
2. **Log transactions and payments**, and let the engine compute the statements
   itself — interest dated from each transaction, the minimum due under your
   issuer's own formula, late fees by slab, and whether the card is revolving.

[`src/lib/finance/cardState.ts`](src/lib/finance/cardState.ts) resolves the two
into one answer. The ledger wins wherever it has data, because it is strictly
more informed. Everything downstream — the dashboard tiles, the card health
panel, the upcoming-dues list, the payoff planner — reads from that single
resolver, so no two places in the app can ever quote a different balance for the
same card.

The Ledger tab is also the only place you will see *why* you were charged
interest: which transaction date each charge runs from, and what the grace
period cost you when it was lost.

Loans work the same way. Mark an EMI paid and
[`src/lib/finance/loanState.ts`](src/lib/finance/loanState.ts) derives the
outstanding principal from what is actually recorded, falling back to the
schedule read at today's date. The `outstandingPrincipal` on the record is
never trusted: it is a number typed once that goes stale the moment a payment
lands, and reading it is how a loan balance quietly drifts away from reality.

## The credit card engine

This is the part worth reading the source of. It lives in
[`src/lib/finance/creditCard.ts`](src/lib/finance/creditCard.ts).

Every Indian issuer charges on the Average Daily Balance:

```
interest = balance × (APR / 100) × days / 365
```

The trap is the interest-free period. Pay the statement in full by the due date
and retail spends cost nothing. Pay even one rupee less and you lose that grace
**retroactively, from each transaction date** — not from the statement date.

That retroactivity is why the engine cannot work one statement at a time: a
purchase on 10-Apr can be charged interest on the 18-May statement. So it
simulates a continuous day-by-day ledger of open *lots*, each remembering when
it originated. Every lot accrues from its own date; at each due date we learn
whether grace was earned, and if it was, the provisional interest on eligible
lots is waived. If it was not, the interest stands and every open lot loses
grace permanently.

It also handles:

| Case | Behaviour |
| --- | --- |
| Paid in full by due date | Zero interest on retail. Grace retained. |
| Paid minimum only | Interest from every transaction date. No late fee. |
| Paid partial (> min, < full) | Same as minimum. Grace lost. |
| Paid nothing | Late fee by slab, plus all transaction-date interest. |
| Cash advance | Accrues from day one, always. Fee: 2.5% or ₹500. |
| Refund clearing the statement | Settles it, same as a payment would. |
| Overpayment | Held as credit and spent by the next purchase. |
| Over limit | 2.5% of the excess, minimum ₹500. |
| Late fee | Billed next cycle, attracting 18% GST, 100% mandatory in the MAD. |

**Minimum Amount Due** is the composite the issuers actually use — 100% of EMI,
GST, fees, finance charges and overlimit, plus X% of the rest (5% for most, 2%
for IndusInd). HDFC's alternate 30% formula is applied as an additional *floor*,
never as a substitute, so it can never waive the mandatory components.

---

## Money

**Every rupee amount in this codebase is an integer number of paise.** ₹1,234.56
is `123456`. Floating point is never used for money anywhere.

Addition and subtraction of integers is exact in JS up to
`Number.MAX_SAFE_INTEGER` — about ₹90 lakh crore, comfortably beyond any
personal balance sheet. Anything that multiplies or divides (rates, percentages,
splits) goes through [big.js](https://github.com/MikeMcl/big.js) so no binary
float error can reach a balance. `allocate()` splits an amount across weights
using the largest-remainder method, so the parts always sum back to the total
without losing or inventing a paisa.

---

## Stack

| Layer | Choice |
| --- | --- |
| Build | Vite 8 (Rolldown) |
| UI | React 19, TypeScript 7 |
| Routing | TanStack Router (code-based, fully typed) |
| State | Zustand |
| Local store | Dexie (IndexedDB) |
| Sync | GitHub REST API via Octokit, loaded on demand |
| Styling | Tailwind CSS v4 |
| Components | shadcn/ui patterns on Radix primitives |
| Icons | [Phosphor](https://phosphoricons.com) |
| Charts | Recharts, lazily loaded |
| Money | big.js · **Dates** date-fns · **Validation** Zod |
| PWA | vite-plugin-pwa (Workbox) |
| Tests | Vitest (unit) · Playwright (e2e) |
| Lint | oxlint |

### Bundle

Everything the build emits is precached, so the whole app — every page, every
chart, CSV import and PDF export — works offline from the first visit.
Precache total: **2.38 MB, 45 entries**. That is a background service-worker
install and does not compete with first paint; the number that governs how fast
the app opens is the JavaScript fetched during load, which is **284 kB**.

The heavy dependencies are kept off that critical path by lazy loading rather
than by excluding them from the cache:

| Dependency | Size | Fetched when |
| --- | --- | --- |
| jsPDF + html2canvas + canvg | 733 kB | You export a report as PDF |
| Recharts | 413 kB | A chart scrolls within 400 px of the viewport |
| Octokit | 105 kB | Sync is configured |

None of these is a named vendor chunk. Forcing them into one is what let Vite's
`__vitePreload` helper get captured inside the PDF bundle, which made 780 kB of
jsPDF a static dependency of the app shell — see `docs/Memory.md` §9.

---

## Tests

```bash
npm run test       # 309 unit tests
npm run test:e2e   # 42 end-to-end tests, desktop and mobile
```

**309 unit tests**, concentrated where being wrong costs real money. The finance
engine is checked against published figures rather than against itself:

- EMI matched to bank calculators for ₹10L @ 8.5%/240mo, ₹5L @ 12%/60mo and
  ₹50L @ 7.25%/360mo.
- Amortization schedules close to **exactly** zero across rates, tenures and
  prepayment modes.
- Card interest reproduces HDFC's published worked example (₹15,000 held 32 days
  at 45% → ₹591.78; their illustration rounds to ₹591.75).
- Every late-fee slab boundary, including the off-by-one at ₹100.
- MAD under the standard 5%, IndusInd's 2%, and HDFC's 30% variant.
- Tax at the FY 2025-26 slab boundaries, with 87A marginal relief applied under
  the new regime only (the old regime's 87A is a hard cliff) and surcharge
  marginal relief at every threshold.

[`tests/finance.regressions.test.ts`](tests/finance.regressions.test.ts) locks
in thirteen defects found by an adversarial audit of the engine — among them a
payment dated exactly on the statement date being double-counted, carried
transactions being silently dropped, and `new Date('YYYY-MM-DD')` parsing as UTC
and shifting the first EMI by a month in any timezone west of Greenwich.

**42 end-to-end tests** run against the *production* build, on desktop and a
Pixel viewport, so what is tested is what ships — real base path, code-split
chunks and all. They cover what unit tests structurally cannot: that figures on
the dashboard reconcile with the pages they came from, that every route loads
without throwing, that nothing overflows horizontally at 375px, and that data
survives a reload. Running them found two real bugs that unit tests could not
have: a dashboard rendering real income against zero spending while its queries
resolved separately, and a command palette that silently refused to navigate
because it was mounted as a sibling of the router rather than inside it.

---

## Project layout

```
src/
  lib/finance/      Pure, tested financial logic — no React, no database
    money.ts          Integer-paise arithmetic and Indian formatting
    dates.ts          Billing cycles, due dates, financial years
    emi.ts            EMI, amortization, prepayment
    creditCard.ts     The ADB interest ledger, MAD, payoff planner
    salary.ts         CTC → in-hand, income tax, HRA exemption
    bills.ts          Recurring bills, electricity units
    dashboard.ts      Derived aggregates for the dashboard
    cardState.ts      Resolves ledger vs entered statements into one answer
  lib/db/           Dexie schema, the single write path, sample data
  lib/sync/         Merge rules (pure) and the background sync engine
  lib/github/       GitHub API client
  components/       UI kit, charts, icons, shared widgets
  pages/            One file per screen
  routes/           Typed route tree
```

The `lib/finance` modules are pure functions over plain data. That is what makes
them testable, and it means the whole dashboard recomputes in microseconds from
data already in memory.

---

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl/⌘ K` | Command palette — jump anywhere, search expenses |
| `N` | Add an expense |
| `Ctrl/⌘ Enter` | Save and close the **quick-add** dialog (not wired up in the others yet) |

Shortcuts are ignored while you are typing in a field.

---

## Lender rates

`src/data/lenders.json` carries indicative ranges for every major Indian bank
and NBFC across home, personal, car, education, gold and property loans.
Selecting a lender pre-fills a plausible rate; the field stays editable because
the only rate that matters is the one you were actually sanctioned.

A monthly Action nudges the ranges towards the published MCLR benchmark. It
never scrapes individual bank sites — those change constantly and their terms
usually prohibit it — and if the source is unreachable or the parse looks
implausible it changes nothing and still exits green. A stale rate is a mild
annoyance; a corrupted rate file would be worse.

---

## Privacy

- All data lives in your browser's IndexedDB.
- With sync on, a copy lives in **your** private GitHub repo. Nowhere else.
- The token is stored on-device and sent only to `api.github.com`.
- No analytics, no telemetry, no third-party requests at runtime. The app's
  strict dependency set means there is nothing phoning home to notice.
- PDF export renders locally from the DOM; nothing is uploaded to produce it.

---

## Not included

Stated plainly so nothing here is a surprise:

- **No bank connection.** Statements and balances are entered by you. Account
  aggregator integration would need a licensed TSP and is not free.
- **No push notifications.** Reminders are in-app banners and badges. Web push
  needs a server to hold VAPID keys.
- **No multi-user.** One person, any number of devices.
- **Tax figures are estimates** for planning, not tax advice. Capital gains and
  perquisites are not modelled.
- **Statement interest is computed from what you enter.** The engine is accurate
  to the published methods, but it cannot know about an issuer-specific waiver
  or a promotional rate you were given.

---

## Licence

MIT. It is your money and your data; do what you like with the code.
