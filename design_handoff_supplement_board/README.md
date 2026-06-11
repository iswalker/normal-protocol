# Handoff: Supplement Ordering Board

## Overview
A Trello-style planning board for managing recurring supplement re-orders. Items
("cards") are grouped into **Shipments** (by merchant) inside **Month** columns.
Each item shows a live countdown to when it runs out, and lets you enter a price
and an order quantity (in bottles) to see how ordering extends the runway and what
it costs. Per-month roll-up metrics summarize spend.

The board supports drag-and-drop (reorder items, move them between shipments and
months, drag shipments around), inline editing, and three card-density layouts.

---

## About the Design Files
The files in `prototype/` and `Supplement-Board-standalone.html` are **design
references built in plain HTML/CSS/JS** — a working prototype that demonstrates the
intended look, calculations, and interactions. They are **not** meant to be shipped
as-is.

**The task is to recreate this design in the target codebase's environment** (React,
Vue, Svelte, SwiftUI, etc.) using its established component patterns, state
management, and styling conventions. If there is no existing codebase yet, pick the
framework best suited to the project (a React + TypeScript SPA is a natural fit) and
implement it there. Treat the HTML/CSS as the source of truth for **visual design
and behavior**, and the math in `data.js` as the source of truth for the **domain
logic**.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, and interactions are all
present and intentional. Recreate the UI faithfully, but swap the vanilla
DOM/SortableJS implementation for the codebase's idiomatic equivalents (e.g. a React
component tree with `@dnd-kit` or `react-beautiful-dnd` for drag-and-drop).

---

## The Domain Model (read this first)

Everything on a card derives from a small set of stored inputs. Get this right and
the UI is straightforward.

### Stored fields per item
| Field | Meaning |
|---|---|
| `name` | Item name (editable) |
| `amount` | Capsules on hand **as of `loggedOn`** (not today) |
| `dose` | Capsules consumed per day (the spreadsheet's "Daily Dose") |
| `bottleSize` | Capsules per bottle |
| `loggedOn` | ISO date the `amount` was recorded |
| `price` | Price per **bottle** |
| `qty` | Number of **bottles** to order |
| `includeInMonthTotal` | Whether this line counts toward the month's **Planned** total (per-row toggle) |

### Derived values (computed at render, never stored)
Let `today` = the real current date. All day counts are floating point until
displayed (then rounded; values ≤ 0 display as `out`).

```
elapsedDays   = max(0, today − loggedOn)          // in days
onHand        = amount − dose × elapsedDays        // capsules left today (may be < 0)
currentDaysLeft = onHand / dose
currentRunOut   = loggedOn + (amount / dose) days  // == the spreadsheet "Run Out"

// When an order quantity is entered (qty bottles):
addedCapsules = qty × bottleSize
newOnHand     = onHand + addedCapsules
newDaysLeft   = newOnHand / dose
newRunOut     = today + newDaysLeft days            // fresh stock starts today

orderCost     = price × qty                          // price is per bottle
```

**Worked examples (with `today = 2026-06-05`):**
- **ATP** — dose 11, bottle 120, logged 6/4, amount 110. elapsed ≈ 1 day →
  onHand ≈ 99 → ~9 days left, runs out ~Jun 14. Order 1 bottle (+120) →
  ~19 days left, runs out ~Jun 24. Cost = $63 × 1 = **$63.00**.
- **Serratia** — dose 1, bottle 180. Ordering 1 bottle adds 180 days of supply →
  a large jump (e.g. 7 → 187 days). Illustrates that bottle size, not capsule
  count, drives the runway extension.

### "Old → New" display
When `qty > 0`, the card shows the **current** day count and run-out date struck
through / de-emphasized, an arrow, then the **new** projected values in the accent
color. When `qty == 0`, only the current values show.

### Urgency tiers (drives the colored left edge)
```
currentDaysLeft <= 0           → "out"  (red edge,   #d6504a)
0 < currentDaysLeft < threshold → "soon" (amber edge, #e08a3c)
otherwise                       → "ok"   (no edge)
```
`threshold` defaults to **10** days and is adjustable via the Tweaks panel.

---

## Totals & Roll-up Metrics

Each Month column header shows four metrics. Let `spent` be the month's editable
"already invested" figure.

| Metric | Formula |
|---|---|
| **Spent** | User-entered per month (editable money input). Money already invested. |
| **Shipments** | Σ `orderCost` of every item **inside a shipment** (ignores the toggle). The merchant subtotal sum. |
| **Planned** | `spent` + Σ `orderCost` of every item (shipment **or** loose) **whose toggle is ON**. |
| **Max** | `spent` + Σ `orderCost` of **every** item in the month, toggle or not. The ceiling if you order everything. |

Each **Shipment** also shows its own subtotal = Σ `orderCost` of its items.

**Seed example (June):** Spent $480 · Shipments $298.00 · Planned **$760.00** · Max
**$814.00**. (Serratia is toggled off, so Planned = Max − its $54 line.)

---

## Layout & Structure

```
┌─ App bar ───────────────────────────────────────────────────┐
│ [logo] Supplement Ordering · planner        live as of <date>│
├─ Board (horizontal row of Month columns; page scrolls) ─────┤
│ ┌─ Month ──────────────────┐  ┌─ Month ──────┐  ┌─ Month ─┐ │
│ │ Header: title + 4 metrics│  │ ...          │  │ ...     │ │
│ │ ┌ Shipment ───────────┐  │  │              │  │         │ │
│ │ │ head: name (n) total│  │  │              │  │         │ │
│ │ │  [card] [card] ...   │  │  │              │  │         │ │
│ │ │  + Add item          │  │  │              │  │         │ │
│ │ └─────────────────────┘  │  │              │  │         │ │
│ │ [loose card]             │  │              │  │         │ │
│ │ ┌ Shipment ───────────┐  │  │              │  │         │ │
│ │ └─────────────────────┘  │  │              │  │         │ │
│ │ + Shipment   + Item      │  │              │  │         │ │
│ └──────────────────────────┘  └──────────────┘  └─────────┘ │
└──────────────────────────────────────────────────────────────┘
```

- The **page** is the scroll container. Columns grow to fit all their cards (no
  internal column scroll); the page scrolls vertically for tall columns and
  horizontally to reach more months.
- A month contains an **ordered list of "blocks"**, where each block is either a
  **Shipment** (which itself contains an ordered list of cards) or a **loose card**
  (a card not inside any shipment). Loose cards may sit between shipments.

---

## Components (exact specs)

### App bar
- White background, 1px bottom border `#e4e9ea`, padding `14px 24px`.
- Logo mark: 26×26, radius 7, linear-gradient(150deg, `#70c4bb` → `#3f8f87`), with a
  white ring glyph (10×10 circle, 2.5px white border) centered.
- Title: IBM Plex Sans 15px / 600, "Supplement Ordering"; " · planner" in `#8a979e`/500.
- Right: a pulsing 7px accent dot + "live as of &lt;Mon D, YYYY&gt;" in IBM Plex Mono 11.5px `#8a979e`.

### Month column
- Width **480px** (fixed) in the default *Compact* layout; column does not shrink.
- Background `#e7eced`, 1px border `#dde3e4`, radius 14.
- **Header** (single row): title group on the left, metrics group on the right.
  - Title: month name (IBM Plex Sans 16/600, editable) + year sub (Plex Mono 11px
    `#8a979e`) + a count chip (Plex Mono 10px, bg `#dbe2e3`, radius 20, pill).
  - Metrics: four stacked label/value pairs separated by 1px left borders
    (`#d7dedf`), right-aligned. Label = 8.5px/600 uppercase `#8a979e`, letter-spacing
    .06em. Value = Plex Mono 14.5px/500. **Planned** value uses `#3f8f87`/600;
    **Max** value uses `#51606a`. **Spent** value is an editable number input
    (`$` prefix, dashed underline on hover/focus, auto-sizes to its content).
- **Footer**: two dashed "+ Shipment" / "+ Item" buttons.

### Shipment block
- White, 1px border `#e4e9ea`, radius 11, subtle card shadow.
- **Header**: drag grip (six-dot, appears on hover) · 22×22 white truck icon tile
  (border `#cfe6e2`, accent icon) · name (Plex Sans 13/600, editable, ellipsis) ·
  count chip (Plex Mono 10px, bg `#d6e6e2`, pill) · subtotal (Plex Mono 14/600,
  `#3f8f87`) · delete ✕ (hover only). Header band has a faint accent gradient
  (`#eaf6f4` → `#f3faf9`), 1px bottom border `#dcebe8`.
- **Body**: vertical stack of cards, 9px gap, min-height keeps it a drop target.
  Empty state shows a dashed "Drop a card here" hint.
- **Footer**: dashed "+ Add item" button.

### Card — Compact layout (the default / primary view)
A single dense row, ~ one line tall. CSS grid with these columns (within a 480px
column → 436px content width):

| Grid column | Width | Align | Contents |
|---|---|---|---|
| name | `1fr` (~160px) | left | drag grip (hover) + name (editable, ellipsis, 13px/600) |
| proj | 162px | **center** | days-left + run-out (each "old → new"); 15px right padding |
| order | 82px | **right** | `$`<input> `×` <input> — auto-sized number inputs |
| foot | 84px | right | line total (Plex Mono 13px) + the per-row toggle switch |
| del | 22px | center | delete ✕ (faint 0.4 opacity, solid on hover) |

- Days-left value: Plex Mono 13px; current value in ink, "new" value in accent. When
  an order exists the current value shrinks/greys and the new value (accent) follows
  an arrow. Run-out dates use a short `M/D` numeric format in this layout.
- Number inputs: light fill `#f7f9f9`, 1px border `#e4e9ea`, radius 7, height 24,
  Plex Mono 12px, right-aligned, auto-width-to-content. Focus → accent border, white
  fill.
- The **toggle** (include-in-Planned) is a switch only, no label: 26×15 track, white
  13px knob; OFF `#d2d9da`, ON `#70c4bb`.
- The **delete ✕** sits in its own far-right column, faint by default.

### Card — Detailed & Split layouts (alternate, via Tweaks)
Same data, roomier presentation (kept as design options):
- **Detailed**: stacked — name + status badge, a "Days left / Runs out" projection
  block (with `MMM D` dates), a "Price / bottle" + "Order / bottles" input row, then
  a meta line (`on hand X · N/day · M/btl`) and the order total. Toggle + ✕ on the
  right of the footer.
- **Split**: identity + big day count on the left, order controls on the right.

These three are toggled by the `cardLayout` tweak (`compact` | `detailed` | `split`).

---

## Interactions & Behavior

### Drag and drop (nested)
Implemented with SortableJS in the prototype; recreate with the codebase's DnD lib.
- **Cards** can be reordered within a shipment, moved between shipments, moved into
  or out of a shipment (becoming "loose"), and moved between months. Drag handle =
  the six-dot grip (visible on hover).
- **Shipments** can be reordered within a month and moved between months. Drag handle
  = the grip in the shipment header.
- A shipment **cannot** be dropped inside another shipment's body (only cards can).
- Inputs and editable text are excluded from drag initiation so editing still works.
- After any drop: recompute all derived values + totals, and persist.

### Inline editing
- **Item name, shipment name, month name**: `contenteditable`; Enter commits (blurs);
  paste is coerced to plain text.
- **Price, Order qty**: number inputs. On input → update that card's derived values
  and bubble totals up to its shipment + month.
- **Spent**: per-month number input; on input → recompute that month's Planned & Max.

### Add / delete
- "+ Item" (month footer) adds a loose card; "+ Add item" (shipment footer) adds a
  card to that shipment. New cards default to **toggle ON** and seed values
  (`amount 30, dose 1, bottleSize 30, price 0, qty 0, loggedOn = today`), then focus
  the name for immediate editing.
- "+ Shipment" adds an empty shipment to the month.
- Delete ✕ removes a card (per row) or a shipment (header, hover).

### Per-row toggle
Flipping a card's switch includes/excludes its line from the month's **Planned**
total (live). **Max** and **Shipments** are unaffected.

### Live countdown
All day counts and run-out dates derive from the real current date, so they tick down
over time. (Prototype recomputes hourly while open.)

### Persistence
The whole board state is saved to `localStorage` and restored on load (key
`sb_state_v6`; the version suffix lets a schema change invalidate old state). See
`sample-data/board-state.json` for the exact persisted shape.

---

## State Management

Conceptual state (see `board-state.json` for the literal seed):

```
Board
├── months: ordered[]            // each: { id, name, sub, spent, blocks[] }
│     └── blocks: ordered[]       // each: { type:'shipment', id, cards:ordered[] }
│                                 //   or  { type:'card', id }   (a loose card)
├── shipments: map<id, { name }>
└── items:     map<id, { name, amount, dose, bottleSize, loggedOn, price, qty, includeInMonthTotal }>
```

- Ordering and nesting live in `months[].blocks` (and `blocks[].cards`); item/shipment
  *properties* live in the `items` / `shipments` maps keyed by id. This separation
  makes drag-and-drop a pure reordering of id lists.
- Derived per-card values and all totals are **computed**, never stored.
- A drag, edit, toggle, add, or delete → recompute affected totals → persist (debounced).

---

## Design Tokens

### Color
| Token | Hex | Use |
|---|---|---|
| accent | `#70c4bb` | primary; toggles ON, "new" projections, active states |
| accent-deep | `#3f8f87` | Planned value, shipment subtotal, emphasis |
| accent-tint | `#eaf6f4` | shipment header band, total chips |
| ink | `#1c2426` | primary text |
| ink-2 | `#51606a` | secondary text, Max value |
| ink-3 | `#8a979e` | labels, muted |
| line | `#e4e9ea` | hairline borders |
| line-soft | `#eef2f2` | softer dividers |
| bg | `#eef1f2` | app background |
| column bg | `#e7eced` | month column |
| paper | `#ffffff` | cards / shipments |
| soon | `#e08a3c` (tint `#fdf3e8`) | urgency: runs out soon |
| out | `#d6504a` (tint `#fbecea`) | urgency: depleted |

The accent is themeable via the Tweaks panel (curated palettes: teal default, blue,
indigo, slate — each sets accent / accent-deep / accent-tint together).

### Typography
- **UI / labels / names:** IBM Plex Sans (400, 500, 600).
- **Numbers, dates, money, metrics:** IBM Plex Mono (400, 500). Use tabular/mono
  figures everywhere numbers align in columns.
- Notable sizes: month title 16/600 · metric label 8.5/600 uppercase · metric value
  14.5/500 · card name 13/600 · compact day value 13 · inputs 12–13 · app title 15/600.

### Spacing, radius, shadow
- Radii: cards 10–11, shipments 11, columns 14, inputs 7, pills/toggles 20+ (full).
- Card shadow: `0 1px 2px rgba(28,36,38,.06), 0 1px 1px rgba(28,36,38,.04)`.
- Pop/drag shadow: `0 10px 28px rgba(28,36,38,.16)`.
- Column gap 18px; card gap 9px (compact 5px); board padding `22px 24px 64px`.
- Loose cards use a **dashed** border (`#cdd6d8`) to read as "outside a shipment".

### Urgency threshold
Default 10 days; adjustable 3–30 via Tweaks.

---

## Assets & Dependencies
- **Fonts:** IBM Plex Sans + IBM Plex Mono (Google Fonts in the prototype; use the
  codebase's font-loading approach).
- **Drag-and-drop:** SortableJS 1.15.6 in the prototype (CDN). Replace with the
  codebase's preferred DnD solution.
- **Tweaks panel:** a prototyping-only affordance (React + a small host protocol) for
  toggling card layout / accent / urgency threshold. **Not part of the product** —
  omit it, or fold its options into real app settings if desired.
- **Icons** (grip, truck, plus, delete ✕) are inline SVG in `prototype/board.js`
  (`ICON` map) — reuse or swap for the codebase's icon set.
- No backend; all state is local. Real integration would replace `localStorage` with
  the app's data layer / API.

---

## Files in this bundle
```
design_handoff_supplement_board/
├── README.md                          ← this document (self-sufficient spec)
├── Supplement-Board-standalone.html   ← the full prototype as ONE offline file
│                                         (open directly in any browser, no setup)
├── prototype/                         ← the editable source the prototype is built from
│   ├── Supplement Board.html          ← entry point / markup shell
│   ├── board.css                      ← all styles + the 3 card-layout variants
│   ├── board.js                       ← rendering, drag-and-drop, editing, totals, persistence
│   ├── data.js                        ← SEED data + all calculation helpers (domain logic)
│   └── tweaks-panel.jsx               ← prototyping-only tweak panel (safe to ignore)
├── sample-data/
│   ├── items.csv                      ← the 10 seed items, spreadsheet-style
│   └── board-state.json              ← the exact persisted board state (canonical shape)
└── reference/
    ├── spreadsheet-data.png           ← original source spreadsheet (Amount/Dose/Bottle/Run Out)
    └── trello-layout-reference.png    ← the Trello layout that inspired the board
```

**Start here:** open `Supplement-Board-standalone.html` to play with the live design,
read "The Domain Model" and "Totals" above, then read `prototype/data.js` for the
authoritative calculations.
