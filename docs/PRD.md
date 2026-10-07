# PaisaTrack — Product Requirements

**Status:** v1 shipped · **Owner:** @J5pecter · **Last updated:** 2026-10-06

---

## 1. What this is

A personal finance tracker for one person in India, running entirely in their
browser, synced through a private GitHub repo they own.

**The constraint that shapes everything:** ₹0 forever, no credit card at any
step. Not a free tier that can expire — GitHub's permanently free products only.
That single constraint rules out a server, a managed database, auth-as-a-service,
push notifications, and bank aggregation. Every design decision downstream falls
out of it.

## 2. Who it is for

**Primary user: a salaried bachelor in India.** Rented flat, one or two credit
cards, one or two loans, the usual monthly bills. Earns in a single currency,
files one tax return, has nobody else on the account.

What this person actually needs, in priority order:

1. **How much of this month's money is left**, after everything already
   committed. Not last month's statement — right now.
2. **What is about to leave the account**, and when.
3. **What the credit card is really costing**, because the number on the
   statement is not the number they will pay.
4. A reason to pay more than the minimum.

What they do **not** need, and what this deliberately is not: a business
accounting tool, a budgeting philosophy, a social app, or anything that asks for
their netbanking password.

### Non-users

- Couples or families sharing finances (single-user by design)
- Business owners needing GST, invoicing or double-entry books
- Anyone wanting automatic bank feeds

## 3. Problem statement

Indian personal finance has three traps that cost real money and that no
mainstream app surfaces honestly:

| Trap | What it costs | What apps usually show |
| --- | --- | --- |
| Losing the interest-free period | Interest dated from the **transaction** date, not the statement date — a ₹15,000 purchase on the 10th billed from the 10th | "Interest charged: ₹X" with no explanation |
| Paying the minimum due | ₹1,00,000 at 43.2% → **15 years** and ₹2.1 lakh of interest | "Minimum due ₹5,180" presented as a helpful option |
| Choosing the wrong tax regime | Tens of thousands a year | Nothing |

Meanwhile the apps that would tell you either want a subscription or want your
bank credentials.

## 4. Goals and non-goals

### Goals

- **G1** — One screen that answers "where do I stand this month".
- **G2** — Credit card interest computed to the published method, with the
  retroactive grace-period loss modelled correctly.
- **G3** — Quantify the minimum-due trap in years and rupees.
- **G4** — Full loan amortization with prepayment maths.
- **G5** — CTC → in-hand, and new-vs-old regime for FY 2025-26.
- **G6** — Works offline; installs as an app.
- **G7** — Syncs across the user's devices with no server.
- **G8** — ₹0 forever, no card.

### Non-goals

- **N1** — Bank connection. Needs a licensed account-aggregator TSP; not free,
  and would require handing over credentials.
- **N2** — Push notifications. Needs a server to hold VAPID keys. In-app
  banners and badges instead.
- **N3** — Multi-user or shared accounts.
- **N4** — Tax filing. The regime comparison is for planning, not submission.
- **N5** — Investment advice or recommendations of any kind.

## 5. Features

### 5.1 Shipped in v1

| # | Feature | Acceptance |
| --- | --- | --- |
| F1 | **Dashboard** — month snapshot, upcoming dues, debt overview, card health, spend by category, 12-month trend, net worth | Every figure reconciles with the page it came from |
| F2 | **Credit cards** — CRUD, statement logging, payment logging | Outstanding and utilization update correctly |
| F3 | **Card ledger** — transaction-level, engine-computed statements | Interest runs from each transaction date; grace loss is retroactive |
| F4 | **Minimum-due trap** — years and total interest | ₹1L at 43.2% reports 15 years, ₹2.1L interest |
| F5 | **Payoff planner** — avalanche vs snowball | Avalanche never costs more interest |
| F6 | **Loans** — amortization, prepayment, lender rate database, mark EMI paid | Schedule closes to exactly zero; outstanding derives from recorded payments |
| F7 | **Salary** — CTC → in-hand, tax regime comparison | Payslip column sums to gross; FY 2025-26 slabs with 87A and surcharge relief |
| F8 | **Bills** — recurring templates, monthly entries, electricity units | Variable bills prompt; spikes are flagged |
| F9 | **Expenses** — quick add, filters, bulk ops, CSV in/out | Round-trips through the same column set |
| F10 | **Budgets** — per-category limits, safe-to-spend | Over-budget flagged; safe-to-spend ignores overspends |
| F11 | **Investments and goals** — holdings, allocation, monthly-needed | Gains computed against invested principal |
| F12 | **Reports** — monthly and FY, CSV and PDF | PDF renders locally, nothing uploaded |
| F13 | **GitHub sync** — optional, last-write-wins, tombstoned deletes | Two devices converge on the same state |
| F14 | **PWA** — offline, installable | Whole app works with the network off |
| F15 | **Command palette** — Ctrl/⌘K, N to add | Jumps to any page, searches expenses |
| F16 | **Help** — where the data lives, what sync costs, why interest was charged | Worked examples are computed by the engine at render, so the page cannot quote a stale figure |
| F17 | **Mobile secondary navigation** — four tabs plus a "More" sheet | Every page is reachable on a phone without a keyboard |
| F18 | **Cash and bank** — confirmed balances, spending attributed per account, recount with drift | Net worth counts liquid assets; the gap between expected and counted is named rather than absorbed |
| F20 | **Statement import** — bank, card, UPI app and mutual-fund CAS, from PDF or CSV | Read in the browser; every row reviewed before anything is written; re-importing an overlapping period is safe |
| F19 | **Install to home screen** — real prompt on Android/Chrome, Share-sheet instructions on iOS | Opens full-screen and offline; the prompt is dismissible and never returns, but Settings keeps the option |

### 5.2 Explicitly deferred

| Feature | Why | Would need |
| --- | --- | --- |
| Push notifications | No server for VAPID keys | A server, or a paid push service |
| Bank feeds | Not free, needs a TSP licence | Account aggregator integration |
| Multi-currency | Out of scope for the target user | FX rates, a rate source |
| Shared/family accounts | Single-user by design | Auth, a server, permissions |
| Receipt OCR | Needs a vision model or a paid API | Either a server or a paid key |

## 6. Success criteria

The product is working if:

1. **The dashboard tells the truth.** Every figure agrees with its source page.
   Tested end-to-end, not by eye.
2. **The finance engine matches published figures.** Bank EMI calculators, HDFC's
   worked interest example, the FY 2025-26 slab boundaries.
3. **It works with the network off**, including the first visit after install.
4. **It costs ₹0** and never asks for a card.
5. **Nothing leaves the device** except to `api.github.com`, and only when the
   user has explicitly configured sync.

## 7. Constraints and risks

| Constraint | Consequence |
| --- | --- |
| GitHub Pages is public-only on the free plan | App repo public, data repo private; the app contains no personal data |
| GitHub Actions free minutes (2,000/mo private) | Nightly data-repo backup ≈ 30 min/month; app repo is public so unlimited |
| GitHub API 5,000 req/hr | Real usage ≈ 100/day; ETag polling returns 304 at no cost |
| No server | No auth, no server-side validation, no rate limiting of inbound traffic, no uptime monitoring. The device is the trust boundary. |
| IndexedDB is origin-scoped | Clearing browser data clears the app. Sync and manual backup are the mitigations, and the UI says so. |

### Risks

- **R1 — Token leakage.** A personal access token lives in IndexedDB.
  *Mitigation:* fine-grained token scoped to one repo with Contents-only
  permission; never logged, never in a URL, never sent anywhere but
  `api.github.com`; one-click disconnect.
- **R2 — User makes the data repo public.** *Mitigation:* connecting to a
  public repo is **refused**, not warned about, and the sync engine re-checks
  visibility on every start so a repo made public later stops syncing rather
  than continuing to push.
- **R3 — Lender rates go stale.** *Mitigation:* monthly refresh Action, rates
  editable, `lastUpdated` shown next to the picker.
- **R4 — Tax rules change each Budget.** *Mitigation:* slabs are a single
  table in `salary.ts` with the FY labelled; output is marked an estimate.

## 8. Open questions

- Should the ledger become the only way to track a card, with statement entry
  dropped? Two paths is more to maintain, but statement entry is what most
  people will actually use.
- Is a monthly email digest worth a GitHub Action that emails via an SMTP
  secret? It is free, but it puts a credential in Actions.
