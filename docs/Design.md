# PaisaTrack — Design

**Last updated:** 2026-10-06

---

## 1. The idea

**A cockpit, not a ledger.** You open this at 11pm to find out whether you can
afford something. It should answer that in under a second, without scrolling and
without cheerfulness.

Three principles:

1. **The number is the interface.** Figures are large, tabular-aligned, and
   never decorated. Everything else is support.
2. **Bad news is legible, not loud.** A 45% interest charge is alarming on its
   own; the UI states it plainly rather than shouting. No red gradients, no
   emoji, no exclamation marks.
3. **Honest about uncertainty.** "Estimate", "typical rate", "last refreshed" —
   labelled where true, because a confident wrong number is worse than a hedged
   right one.

Dark by default. This gets used at night.

---

## 2. Colour

All colour is CSS custom properties defined in `src/index.css`. **Components
never hardcode a hex value** — they reference tokens, which is how light and dark
work without any component knowing a theme exists.

### Semantic tokens

| Token | Dark | Light | Means |
| --- | --- | --- | --- |
| `--color-background` | `hsl(222 47% 8%)` | `hsl(0 0% 100%)` | Page |
| `--color-card` | `hsl(222 44% 11%)` | `hsl(0 0% 100%)` | Raised surface |
| `--color-foreground` | `hsl(210 40% 96%)` | `hsl(222 47% 11%)` | Body text |
| `--color-muted-foreground` | `hsl(217 18% 62%)` | `hsl(215 16% 42%)` | Labels, secondary |
| `--color-border` | `hsl(215 28% 22%)` | `hsl(214 20% 88%)` | Dividers |
| `--color-primary` | `hsl(142 71% 45%)` | `hsl(142 69% 35%)` | Action, brand |
| `--color-success` | `hsl(142 71% 45%)` | `hsl(142 69% 35%)` | Paid, under budget, gains |
| `--color-warning` | `hsl(38 92% 50%)` | `hsl(32 95% 40%)` | Due soon, 30–50% utilization |
| `--color-danger` | `hsl(0 72% 51%)` | `hsl(0 72% 45%)` | Overdue, over budget, interest |
| `--color-info` | `hsl(199 89% 48%)` | `hsl(199 89% 40%)` | Neutral emphasis |

Light-mode values are **darker**, not the same hue — a green that reads well on
near-black is too pale on white. Both sets clear WCAG AA against their
background.

### The money semantics

This is the one convention worth stating explicitly, because it is easy to get
backwards:

| Context | Colour | Why |
| --- | --- | --- |
| Income, savings, gains | green | more is better |
| **Expenses** | **neutral** | spending is not failure; only *overspending* is |
| Over budget, overdue, interest charged | red | the thing you want to act on |
| Due within 7 days | amber | attention, not alarm |

`<Money invertColour>` exists for the inverted case — in the card ledger, a
*payment* is good and a *charge* is bad, which is the reverse of the default.

### Utilization bands

Fixed at the thresholds that actually affect a CIBIL score:

- **< 30%** green
- **30–50%** amber
- **> 50%** red

With a dashed 30% reference line on the utilization chart, because that is the
number the bureaus react to.

### Chart palette

Twelve colours in `chartPalette.tsx`, ordered so adjacent slices stay
distinguishable, and legible on both backgrounds. A category's colour is derived
from a hash of its name, so **Groceries is the same colour on every screen**.

---

## 3. Typography

```
--font-sans: "Inter", ui-sans-serif, system-ui, -apple-system,
             "Segoe UI", Roboto, sans-serif;
--font-mono: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace;
```

No webfont is loaded. The system stack renders instantly, has no layout shift,
no third-party request, and no CSP exception. Inter is used where present.

### Scale

| Use | Size | Weight |
| --- | --- | --- |
| Page title | `text-xl` / `sm:text-2xl` | 600 |
| Headline figure | `text-2xl` – `text-3xl` | 600 |
| Card title | `text-base` | 600 |
| Body | `text-sm` | 400 |
| Label, caption | `text-xs` | 400–500 |
| Micro (badges, legends) | `text-[10px]`–`text-[11px]` | 500 |

### Tabular numerals — non-negotiable

```css
.tnum { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
```

Every monetary figure carries `.tnum`, applied automatically by `<Money>`. In a
column of amounts, proportional digits make the decimal points wander and the
column unreadable. This is the single highest-value typographic decision here.

### Indian number formatting

`Intl.NumberFormat('en-IN')` — lakh/crore grouping, not thousands:

```
₹12,34,568        not  ₹1,234,568
₹1.2L  ₹1.25Cr  ₹12.5K     compact, the way people actually speak
```

Compact forms appear in tight spaces (stat tiles, chart axes, legends) with the
exact amount in the `title` attribute.

---

## 4. Layout

### Structure

- **Desktop (≥ 768px)** — collapsible left sidebar, sticky header, content
  capped at `max-w-7xl`.
- **Mobile (< 768px)** — bottom tab bar with four primary destinations plus a
  **More** button opening a bottom sheet with the remaining seven, sticky
  header, safe-area padding for the home indicator.

### Spacing

Tailwind's 4px scale. Card padding `p-4` / `sm:p-5`; grid gaps `gap-4` / `gap-5`;
section rhythm `space-y-5`.

### Radius

`--radius-lg: 0.75rem` on cards, `0.5rem` on controls, full on badges and
progress bars. Soft enough to feel considered, not so soft it looks like a toy.

### The 375px rule

**Nothing may overflow horizontally at 375px.** Grid and flex children default
to `min-width: auto` and refuse to shrink below their content, which is how a
nowrap badge beside a fixed-width amount silently pushes a page 57px wide. Every
grid that holds cards carries `[&>*]:min-w-0`, and wide content (tables, charts)
scrolls inside its own container.

An end-to-end test asserts zero horizontal overflow on all eleven routes, on
both the desktop viewport and a Pixel 7. It found the bug; it keeps it fixed.

---

## 5. Components

### Density

Information-dense without being cramped. Table rows `py-2.5`, stat tiles
`pt-5`. A dashboard that needs scrolling to show this month's position has
failed.

### State coverage

Every list has four states, and all four are implemented:

1. **Empty, first run** — explains the feature and offers one obvious action.
2. **Empty, filtered** — different copy; offers to clear the filter.
3. **Loading** — skeletons shaped like the content, so nothing jumps.
4. **Populated.**

### Motion

Sparing. 180ms fade for dialogs, 400ms count-up on headline figures, 500ms on
progress bars. All respect `prefers-reduced-motion`.

**Animation is never the path by which a value arrives.** If frames do not run —
a hidden tab pauses `requestAnimationFrame` — the real number is shown
immediately. A finance app displaying ₹0 because an animation did not start is
lying to the user.

### Interaction

- Hover on every interactive element.
- A visible focus ring (`--color-ring`) on every focusable element, never
  removed.
- Destructive actions always confirm, naming the thing being destroyed.
- Forms report success as a toast and errors inline beside the field.

---

## 6. Accessibility

Targeted at WCAG 2.2 AA.

- **Contrast** — all token pairs meet AA in both themes.
- **Keyboard** — everything reachable; `Ctrl/⌘K` palette, `N` quick-add, `Esc`
  closes, `Ctrl/⌘Enter` saves. Shortcuts are suppressed while typing.
- **Skip to content** — first focusable element on the page.
- **Semantics** — real `<table>`, `<nav>`, `<main>`, `<h1>`; `aria-current` on
  the active nav item; `aria-busy` on skeletons; `role="alert"` on field errors.
- **Icon-only buttons** always carry `aria-label`.
- **Colour is never the only signal** — status badges carry text, due dates
  carry words ("Overdue by 4 days"), charts carry a labelled legend.
- **Touch targets** ≥ 44px on mobile.

---

## 7. Voice

Plain, specific, calm. Written as a knowledgeable friend would say it.

| Instead of | Write |
| --- | --- |
| "Oops! Something went wrong 😬" | "GitHub rejected the write. The token may lack Contents: Read and write." |
| "Great job! You're crushing it! 🎉" | "₹66,851 left this month — ₹2,156 a day." |
| "Minimum Due: ₹5,180" | "Paying only the minimum, you would be in debt for 15 years and pay ₹2,12,990 in interest — on a ₹1,00,000 balance." |
| "Sync error" | "That budget will not cover the minimums. You need at least ₹12,400 a month before this debt starts falling." |

Rules:

- **No exclamation marks. No emoji.** This is money.
- **Second person** — "you", not "the user".
- **Say the number**, not "significant" or "a lot".
- **Never congratulate**, never scold. State the position.
- **Indian English** — lakh, crore, EMI, CIBIL, in-hand, autopay. Used because
  they are the correct words here, not as local colour.

---

## 8. Iconography

[Phosphor Icons](https://phosphoricons.com), aliased to app-level names in
`components/icons.tsx` so the vocabulary is consistent and a future swap is one
file.

Weight conventions:

| Weight | Used for |
| --- | --- |
| `regular` | table rows, body-level icons |
| `bold` | navigation, buttons — reads at 16px |
| `fill` | the active nav item, status badges |
| `duotone` | feature cards, empty states, tips |

Phosphor was chosen over alternatives partly for `CurrencyInr` — a real rupee
glyph, in an app where a dollar sign would be absurd.

---

## 9. The brand mark

A "P" monogram crossed by the two horizontal bars of the rupee sign. Green
(`#22c55e`) on slate (`#0f172a`), rounded tile.

Generated programmatically by `scripts/gen-icons.mjs` — a hand-written PNG
encoder with no image dependencies, producing the 192px, 512px and 180px PNG
icons. The SVG favicon is hand-written and lives in `public/`. Rerun with
`node scripts/gen-icons.mjs`.
