# Linting

`npm run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter).

## Why oxlint rather than ESLint

This project is on TypeScript 7, and `typescript-eslint` does not support it —
it refuses to start, pointing at
[issue #10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940).
The options were to pin TypeScript back a major version, or to use a linter
that parses TS/TSX natively without a TypeScript peer dependency. oxlint does,
so the toolchain stays current.

## What is switched on, and why

The rules that earn their place are the ones a typechecker cannot catch.

| Rule | Level | Why |
| --- | --- | --- |
| `react-hooks/rules-of-hooks` | **error** | The one that matters. A hook placed after an early return typechecks cleanly and then throws the first time the component takes the other branch. This was a real bug in `CardLedger` before the rule was added. |
| `react-hooks/exhaustive-deps` | warn | Stale closures in memoised finance calculations are quiet and expensive. |
| `eqeqeq` | error | `==` against a `Paise` value is never what anyone meant. |
| `no-debugger`, `no-alert` | error | Should never reach a build. |
| `typescript/no-non-null-asserted-optional-chain` | error | `a?.b!` asserts away the exact thing the `?.` was there to handle. |

## What is switched off, and why

A linter that reports twenty things nobody intends to fix teaches people to
ignore it, so these are off deliberately rather than left to accumulate:

- **`react/purity`** — flags `new Date()` during render. This is a date-driven
  app: "this month", "days until due" and "is this overdue" are all relative to
  now, and every such call sits inside a `useMemo` or a state initialiser where
  the value is deliberately frozen until its dependencies change. The warning
  describes the design rather than a defect.
- **`react/set-state-in-effect`** — flags controlled inputs syncing to a prop
  (`MoneyInput`, the edit dialogs). React's own documentation describes this as
  the correct pattern for resetting form state when the thing being edited
  changes.
- **unused variables** — already enforced by `tsc` via `noUnusedLocals` and
  `noUnusedParameters`. Duplicating it only produces two reports of one problem.
