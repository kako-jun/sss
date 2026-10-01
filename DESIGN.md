# DESIGN.md

SSS (Screen Shot Saver) — Design System

## 1. Visual Theme & Atmosphere

Monochrome glassmorphism. A pure black canvas where the user's screenshots are the only color. Every UI element exists at minimal visual weight — thin borders, subtle opacity, backdrop blur — so nothing competes with the photo content. The aesthetic is cinematic: a dark room where images glow.

Dark theme only. No light mode. No accent colors.

## 2. Color Palette & Roles

All colors are black or white at varying opacity. This is the entire palette.

### Backgrounds

| Class         | Value              | Usage              |
| ------------- | ------------------ | ------------------ |
| `bg-black`    | `#000000`          | Primary background |
| `bg-black/20` | `rgba(0,0,0,0.20)` | Subtle panel       |
| `bg-black/30` | `rgba(0,0,0,0.30)` | Light panel        |
| `bg-black/40` | `rgba(0,0,0,0.40)` | Standard panel     |
| `bg-black/50` | `rgba(0,0,0,0.50)` | Medium panel       |
| `bg-black/70` | `rgba(0,0,0,0.70)` | Hover background   |
| `bg-black/80` | `rgba(0,0,0,0.80)` | Dark panel         |
| `bg-black/85` | `rgba(0,0,0,0.85)` | Modal overlay      |
| `bg-black/90` | `rgba(0,0,0,0.90)` | Tooltips, submenus |

### Text

| Class           | Value                    | Usage                  |
| --------------- | ------------------------ | ---------------------- |
| `text-white/80` | `rgba(255,255,255,0.80)` | Primary text           |
| `text-white/70` | `rgba(255,255,255,0.70)` | Secondary text         |
| `text-white/60` | `rgba(255,255,255,0.60)` | Tertiary text          |
| `text-white/50` | `rgba(255,255,255,0.50)` | Section headers        |
| `text-white/45` | `rgba(255,255,255,0.45)` | Filenames, paths       |
| `text-white/40` | `rgba(255,255,255,0.40)` | Icon text              |
| `text-white/30` | `rgba(255,255,255,0.30)` | Disabled text, helpers |
| `text-white/25` | `rgba(255,255,255,0.25)` | Very faint icons       |
| `text-white/20` | `rgba(255,255,255,0.20)` | Inactive icon default  |
| `text-white/15` | `rgba(255,255,255,0.15)` | Placeholder            |

**Contrast floor for informational text (#66レビューshould)**: `/30` and `/40` stay
fine for genuinely disabled controls, decorative icon glyphs, or anything with a
3:1 non-text contrast requirement (WCAG 2.4.11) — but any body copy that conveys
information a sighted user is meant to read (Settings section descriptions, empty
-state messages, hints, inline dates) must clear the 4.5:1 normal-text ratio (WCAG
1.4.3), which on this pure-black canvas means `/50` or higher. Several Settings
sections were sitting at `/30`/`/40` for this kind of copy and were bumped to `/50`
during the #66 review pass.

### Borders

| Class             | Value                    | Usage           |
| ----------------- | ------------------------ | --------------- |
| `border-white/10` | `rgba(255,255,255,0.10)` | Standard border |
| `border-white/8`  | `rgba(255,255,255,0.08)` | Subtle border   |
| `border-white/5`  | `rgba(255,255,255,0.05)` | Grid separator  |
| `border-white/20` | `rgba(255,255,255,0.20)` | Focus border    |

### Exception

- `text-red-400/80` — error messages only. The sole non-monochrome color in the system.

### Tailwind Extended (surface tokens)

```javascript
surface: {
  DEFAULT: 'rgba(0,0,0,0.50)',
  subtle: 'rgba(0,0,0,0.30)',
  strong: 'rgba(0,0,0,0.85)',
}
```

## 3. Typography Rules

### Font Family

| Context | Family                             | Weights   |
| ------- | ---------------------------------- | --------- |
| Default | `Inter`, `system-ui`, `sans-serif` | 300 – 500 |

Inter is loaded offline (WOFF2, OFL licensed). No Google Fonts dependency.

### Type Scale

| Element       | Class      | Size | Notes              |
| ------------- | ---------- | ---- | ------------------ |
| Large display | `text-2xl` | 24px | Big numbers        |
| Welcome/title | `text-xl`  | 20px |                    |
| Header        | `text-lg`  | 18px |                    |
| Standard UI   | `text-sm`  | 14px | Buttons, body text |
| Small labels  | `text-xs`  | 12px | Metadata, helpers  |

### Modifiers

- `font-mono` — timestamps, file paths, sizes, counts (monospace for alignment)
- `font-medium` + `uppercase` + `tracking-wider` — section headers
- `truncate` — long file paths
- `tabular-nums` via `font-mono` for number columns

## 4. Component Stylings

### Buttons — Primary (#66)

The one main action on a screen (Scan, Add exclude pattern, Select Folder on the
welcome screen). A filled white button is still monochrome — it's white at high
opacity as a background, black text — and reads as "this is the button to press"
without introducing hue:

```
bg-white/90 hover:bg-white
text-black font-medium
disabled:bg-white/10 disabled:text-white/30 disabled:cursor-not-allowed
rounded-lg
transition-colors text-sm
```

There is at most one primary button per view. Everything else is Standard or Ghost.

### Buttons — Standard

```
bg-white/8 hover:bg-white/15
text-white/60 hover:text-white/80
rounded-lg
transition-colors text-sm
```

Borders are optional here now (#66) — prefer the background contrast alone against
`bg-neutral-950`/`bg-black` panels. Add `border border-white/8` only where the
button sits directly on bare black with no panel behind it.

### Buttons — Disabled

```
bg-black/20
disabled:text-white/20
disabled:opacity-30 disabled:cursor-not-allowed
```

### Buttons — Icon (#66)

Interactive icon buttons (playback controls, top-right chrome, overlay actions)
need to read clearly at a glance, not just on hover — the pre-#66 default
(`text-white/20` to `/30`) was too faint to be usable without hovering first:

```
text-white/60 hover:text-white/90
hover:bg-white/10 focus-visible:text-white/90
p-2 rounded-lg (or rounded-full inside a pill container)
```

Reserve the older faint treatment (`text-white/20` to `/30`) for genuinely passive/
decorative glyphs that aren't standalone interactive targets (e.g. the small
in-thumbnail map pin icon, which sits on its own clickable thumbnail).

### Buttons — Ghost

Secondary actions next to a Primary button (e.g. "Select Folder" next to "Scan"):

```
text-white/50 hover:text-white/80
hover:bg-white/8
rounded-lg
(no background at rest)
```

### Buttons — Inline hint (#100)

A hint that is also a control (the welcome screen's "? Show keyboard shortcuts"):
Ghost text color with a key-cap chip, no background at rest. Hover/focus-visible only
brightens the text (`/50` -> `/80`) and the chip (`bg-white/8` -> `bg-white/15`) —
no borders or fills are added. The chip is `aria-hidden`; the button's accessible
name comes from its text and `aria-keyshortcuts="?"` exposes the key.

```
text-white/50 hover:text-white/80 focus-visible:text-white/80
chip: bg-white/8 group-hover:bg-white/15 group-focus-visible:bg-white/15
rounded-lg px-2 py-1 text-xs transition-colors
```

The padding enlarges the click target; offset it with margins (`mt-5 -mb-1` in place
of the former `mt-6`) so the card's vertical rhythm is unchanged.

### Inline Notice with Action (#111)

A short status/notice block inside a Settings tab that carries one Standard button
(e.g. "exclude rules changed — rescan to apply" + "Rescan now"). Use the Panels &
Cards surface (`p-3 bg-black/30 rounded-lg`), body text `text-white/60 text-sm`,
errors `text-red-400/70`. The button is **Standard** (the tab already has its own
Primary button), shows `animate-spin` on its icon and is disabled while running.
Give the block `role="status"`; there is at most one such block per tab.

### Load Error & Inline Failure Notice (#115)

A failure must never look like an empty state or like success. Two components in
`src/components/Settings/SectionErrors.tsx` cover it:

- **Load error** (`LoadError`): replaces a section's content when its fetch rejects.
  Panels & Cards surface (`p-4 bg-black/30 rounded-lg text-center`), message
  `text-red-400/80 text-sm` ("Couldn't load this"), then one **Standard** button with the
  `RefreshCw` icon ("Retry"). `role="alert"`. It is visually and verbally distinct from the
  empty-state card (which is `text-white/50` and says "No … yet"); never reuse the empty
  wording for a failure.
- **Inline notice** (`InlineError`): one line under the control that failed to save/delete
  (`text-xs text-red-400/80`, `role="alert"`). The control is rolled back to the last saved
  value first (`useRollbackSave`). One notice slot per section: repeated failures replace the
  message instead of stacking. A settings _load_ failure uses the same notice with an
  underlined "Retry" text button.

Save notices name their target ("Couldn't save the display interval. Reverted to the previous value."), so several failures in one tab never read as a repeated identical line. When the section is already unmounted the same text goes to the top toast. A startup failure that stops the app from knowing its state (last folder unreadable) uses the empty-state glass card with a **Primary** "Retry" and a **Standard** "Select Folder", never the welcome card.

Fetch-on-mount sections use `useAsyncLoad` (`loading | error | ready`), so "ready with no
rows" and "error" can't be confused.

### Soft Skip Toast (#120)

Shown at the bottom (`fixed bottom-20`, the same pill as the folder-unavailable /
scan-failure notice: `bg-black/80 backdrop-blur-sm text-white/70 text-xs px-4 py-2
rounded-full border border-white/10`) while broken/0-byte photos are being skipped,
from the 3rd consecutive failure; it disappears as soon as a photo renders (or ~6s
after the last failure). Text only, no icon or emoji. When the slideshow stops for
failures, the full-screen guidance card replaces it: "No photos could be loaded" (the
failed set covers the whole playlist) or "Several photos in a row failed to load"
(10 in a row, not known to be everything). Both show **Continue** (the one Primary
button) next to **Open Settings** (Standard, with the gear icon), centered in a
`flex gap-3` row; the subtitle uses an explicit `\n` (`whitespace-pre-line`) so Japanese
breaks at a sentence boundary, never mid-word. There is no retry timer.

### Input Fields

```
bg-black/40 text-white/60
rounded-lg border border-white/8
focus:outline-none focus:border-white/20
px-3 py-2 text-sm
placeholder: text-white/30
```

Read-only fields that display a filesystem path (scan folder, pick destination)
add `truncate` and `title={value}` (#66) — a path is often longer than the field,
and an `<input>` clips it without an ellipsis or a way to read the rest unless
both are set explicitly.

### Select (Dropdown) (#102)

```
sss-select  px-2 py-1 bg-black/40 text-white/60
rounded border border-white/8 text-sm
focus:outline-none focus:border-white/20
```

The closed control stays translucent glass (`bg-black/40`), but the popup list
is drawn by the OS and defaults to a light background (seen on Windows/WebView2),
which clashes with the dark theme. Every `<select>` MUST carry the shared
`.sss-select` class (defined in `src/index.css`): it sets `color-scheme: dark`
and gives `<option>`/`<optgroup>` an opaque `#0a0a0a` background with
`rgba(255,255,255,0.87)` text (about 14.9:1 contrast, above WCAG AA). The popup
must be opaque, so never use a `/NN` alpha colour on options.
`src/test/selectDark.test.ts` scans all components and fails if a `<select>`
lacks the class.

Caveat: on macOS WKWebView / Linux WebKitGTK the popup is drawn natively and
the option CSS (and even `color-scheme: dark`) may not take effect; this is
unverified on real devices. Windows (WebView2) is the primary target.

### Checkboxes / Range Sliders (#122)

```
checkbox:  sss-checkbox      (no Tailwind sizing/colour classes)
range:     sss-range flex-1
```

Native form controls render with the OS theme: on Linux WebKitGTK an unchecked
checkbox is a **white box** even under `color-scheme: dark` (Chromium hides the
difference), clashing with the dark UI. Every `<input type="checkbox|range">`
MUST carry the matching shared class from `src/index.css`, which draws it
explicitly with `appearance: none` so all engines look the same. There is no
radio style because nothing uses a radio; add one (and register it in the scan
test) before the first radio lands.

- **Box**: 20x20px (minimum hit area), `margin: 0 2px` (vertical 0 so the box
  centre matches the first label line, which is 20px tall with `text-sm`),
  4px radius, `bg rgba(0,0,0,0.4)` (same glass as inputs) and a
  `1px rgba(255,255,255,0.5)` border (about 5:1 against `#0a0a0a`, above the 3:1
  non-text contrast of WCAG 1.4.11; the old `white/20` was about 1.8:1). Hover
  brightens the border to 0.75. The colour change eases over 150ms, disabled
  under `prefers-reduced-motion: reduce`.
- **Checked**: `rgba(255,255,255,0.9)` fill with a `#0a0a0a` mark drawn in CSS
  (`::after` + `clip-path: polygon`). No image, icon font or emoji.
- **Focus**: `:focus-visible` only, 2px `rgba(255,255,255,0.6)` ring with
  `outline-offset: 0` (the global 2px offset is clipped at the left edge of the
  settings scroll area; the horizontal 2px margin keeps the ring inside). For the
  range the ring surrounds the whole input (full width x 20px), an intentionally
  long rectangle; the 2px margin also makes its track start 2px inside the
  heading's left edge, which is accepted.
- **Disabled**: opacity 0.3 (same as the existing `disabled:opacity-30` rule),
  `not-allowed` cursor.
- **Range**: 4px rounded track (`white/25`), 20px round white thumb (border-box,
  so `margin-top` is exactly -8px) styled via `::-webkit-slider-*` and
  `::-moz-range-*`. The filled part is not drawn in any engine (Firefox's
  `-moz-range-progress` is deliberately unused so engines look the same). Do not
  set a height with Tailwind on it; the 20px height is the hit area.
- **Forced colors** (Windows High Contrast, passed through by WebView2): the
  browser overrides background colours to `Canvas`, which would turn a checked box
  into an empty one. `@media (forced-colors: active)` sets
  `forced-color-adjust: none` and uses system colours only: border `ButtonText`,
  checked fill `Highlight` with a `HighlightText` mark, focus ring `CanvasText`
  (a checked box has a `Highlight` fill and border, so a `Highlight` ring would vanish),
  disabled `GrayText` with opacity back to 1 (`GrayText` is already the dimmed
  colour; the normal 0.3 would dim it twice), range track and thumb `ButtonText`
  (thumb `Highlight` on hover). The hover border change applies only to enabled,
  unchecked boxes (`:hover:not(:disabled):not(:checked)`).

`src/test/inputDark.test.ts` walks the TypeScript syntax tree of `src/**/*.tsx` and
fails if any checkbox/range lacks its class (a dynamic `className` such as `cn()`, a
dynamic `type` or any radio counts as an offender), or if the CSS loses
`appearance: none` or the forced-colors rules. It cannot see inputs outside
`.tsx`, in `index.html`, or with a `type` passed through a props spread. The e2e
scenarios (#122) check every state, the label alignment (box centre within 1px of
the first label line) and forced-colors mode in a real browser. Windows
(WebView2) and the WebKitGTK app itself are unverified on real devices.

### Panels & Cards (#66: background over border)

Prefer letting the background contrast do the grouping instead of drawing a
border around every list row, result box, or subsection — a modal already has an
edge (its own border/shadow); repeating thin borders on everything inside it
adds visual noise without adding information. Drop the border where the
background already differs from its parent (a `bg-black/40` row inside a
`bg-neutral-950` modal is legible on its own).

```
Standard:  bg-black/40 rounded-lg
Info:      bg-black/20 rounded-lg
Dark:      bg-black/80 rounded-lg
Modal:     bg-neutral-950 rounded-2xl border border-white/10 shadow-2xl
```

Keep a border only when there's no background difference to rely on (an input
field on bare black, a thumbnail image that needs a defined edge) — see Input
Fields below.

### Confirm Modal (#119)

In-app replacement for `window.confirm` (which Tauri turns into an always-truthy
Promise — never use it). `role="alertdialog"`, `aria-modal="true"`. Same panel as
other modals on a `bg-black/85 backdrop-blur-md` backdrop, portaled to `body`,
narrower (`max-w-md`). Message body (`text-sm text-white/70`,
`whitespace-pre-line`), no visible title — a `sr-only` `<h2>`
("確認" / "Confirm") is referenced via `aria-labelledby`;

```
Panel:    bg-neutral-950 rounded-2xl border border-white/10 shadow-2xl p-7 max-w-md w-full mx-8
Cancel:   Buttons — Standard (bg-white/8 hover:bg-white/15 text-white/60 …)
Confirm:  bg-red-950/60 hover:bg-red-900/60 text-red-400/70 hover:text-red-400/90 rounded-lg text-sm
          (the Settings "danger zone" button style; label names the action, never "OK")
```

Long bodies: the panel is `flex flex-col max-h-[calc(100vh-2rem)]`. The message is
split on `\n\n`; the **last paragraph is pinned outside the scroll area, right
above the button row** (`shrink-0`) so the destructive warning ("This cannot be
undone…") is always readable without scrolling, even on a 360x300 window. Only
the earlier paragraphs scroll (`min-h-0 overflow-y-auto`), with a bottom fade
(`h-8 from-neutral-950 via-neutral-950/80 to-transparent`) shown only while more
text is hidden. The scroll hint (`text-xs text-white/50`, right-aligned,
"矢印キーで続きを表示" / "Arrow keys: scroll for more"; text only, no icon or
emoji, part of the accessible text) is its **own row below the scroll area**
(`shrink-0`), never overlapping the fade or the text; the row's height is reserved
while the body overflows (text swaps for a blank), so nothing jumps when it
appears or disappears. On windows shorter than 420px the panel padding and the
gaps tighten (`[@media(max-height:420px)]`) to leave more body lines; even at
360x300 the warning and buttons stay pinned and visible. A single-paragraph
message is all scroll area (no pinned part).

Keyboard access to the scrolling body: **key handler, not `tabIndex=0`.** While the
body overflows, ↑/↓ (24px), PageUp/PageDown, Home/End on the dialog scroll it;
Tab/Enter/Space/Esc behave as usual and nothing else is intercepted when it does
not overflow. Making the body a focusable `region` would put it before Cancel in
the focus order, so `useFocusTrap` would focus it first and Cancel would no
longer be the default focus — the safe default for a destructive prompt wins.

Esc / backdrop click = Cancel. No emoji.

### Settings Section Rhythm (#66)

Every settings tab is a vertical stack of sections (`space-y-8` between them).
Each section itself follows the same three-part rhythm:

```
<div>
  <h3 className="text-sm font-medium text-white/70">{heading}</h3>
  <p className="text-xs text-white/50 mt-1">{description}</p>  {/* optional */}
</div>
<div className="mt-4">{control(s)}</div>          {/* via the outer space-y-4 */}
```

Description opacity was bumped from `/40` to `/50` (#66レビュー2巡目nit): this
is body copy a user needs to read to understand the control, so it should sit
at the same resting tone as every other "explanation/hint/non-selected" text in
Settings (empty-state messages, the seconds unit label, the language segment's
non-selected option, tab row's non-selected label, the EXIF checkbox label) —
see the contrast-floor note in §2 "Text".

The description is optional but preferred wherever the heading alone doesn't
make the control's effect obvious (e.g. "Display Interval" needs "5–60s, before
switching to the next photo" — "EXIF rotation" checkbox label is already
self-explanatory and doesn't need one). Headings dropped the earlier
`uppercase tracking-wider text-white/50` treatment (#66) — plain sentence case
at `text-white/70` reads calmer and matches the rest of the type scale better.

### Settings Navigation: underline tabs, not a sidebar (#66)

Considered switching the 7 settings tabs to a left sidebar for a more "modern
app" feel, but kept the underline tab row and refined it instead (brighter
`border-b-2` indicator, `font-medium` on the active tab, transparent
placeholder border on inactive tabs so nothing shifts on selection). Reasons:

- The modal is `max-w-2xl` (672px). A sidebar wide enough for the longest label
  ("Exclude Rules"/"除外ルール") would eat roughly a quarter of that, which is
  a much bigger cost at 720px window width than at 1280px — exactly the width
  #66 had to verify against.
- The underline row already has an e2e-verified, working solution for narrow
  widths (`overflow-x-auto`, `flex-shrink-0`, `whitespace-nowrap` — #82): it
  wraps to horizontal scroll instead of breaking, and was confirmed not to
  regress at 720px before this pass even started.
- The tablist itself must also be `shrink-0` (#109): it is a child of the modal's
  `flex-col` body and `overflow-x-auto` gives it a zero min-height, so without
  `shrink-0` a tall tab panel shrank the row (39px to 31px at 1280x800, 21px at
  800x600, clipping the label descenders). Row height is verified constant across
  all tabs and sizes in the real browser by the e2e scenario.
- When the row scrolls horizontally (narrow widths), selecting a tab by click
  also scrolls it into view (`scrollIntoView({inline:'nearest'})` in an effect on
  the active tab); arrow keys already did via `focus()`. Verified at 360x640.
- A sidebar redesign touches the tablist/tabpanel ARIA wiring, the focus trap's
  tab order, and every e2e selector keyed on `.overflow-x-auto` — a much larger
  surface of risk for a lateral (not clearly better) navigation pattern change.

### Icon Pill Group (#66)

Small clusters of icon-only buttons that used to be individual bordered squares
(the top-right window chrome: shortcuts / window mode / settings / exit) are one
pill-shaped glass container instead. Buttons inside have no border or background
of their own at rest — only the pill does:

```
Container: flex items-center gap-0.5 bg-black/50 backdrop-blur-md
           rounded-full border border-white/10 p-1 shadow-2xl
Button:    p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10
```

### Floating Control Bar (#66)

The bottom overlay is a single compact bar that floats above the photo, not a
full-width two-row grid. It fades with the same idle rule as before. Layout is
three flex clusters — info (truncating, `flex-1 min-w-0`) · primary transport
controls (fixed) · secondary actions (fixed):

```
Container: fixed bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-xl
Bar:       flex items-center gap-1 bg-black/50 backdrop-blur-md
           rounded-2xl border border-white/10 pl-2 pr-1.5 py-1.5 shadow-2xl
```

Only show what's actually there — no "No location" / "No date" placeholder
boxes (#66). The GPS thumbnail renders only when the photo has coordinates; the
date only when EXIF has one. File size, display count, and last-displayed time
move from always-visible text into the filename's `title` tooltip — still one
hover away, but not competing for space in the compact bar with the things that
are always present (filename, position).

Progress no longer lives inside the bar. It's an independent full-width hairline
at the very bottom edge of the screen (`fixed bottom-0 left-0 right-0 h-0.5`),
so it always spans the whole photo regardless of the bar's own max-width.

### Submenus/Dropdowns

```
bg-black/90 rounded-xl shadow-2xl border border-white/10
p-1.5 space-y-0.5 backdrop-blur-md
```

The overlay "…" menu opens upward from the floating bar, so its nested Exclude
submenu is anchored by its **bottom** edge (`absolute right-full bottom-0`), not
`top-0`: it is opened from the last row of the parent menu, and growing downward
from there would run past the viewport and over the bar (#110). Any new nested
submenu opened from a bottom-anchored menu follows the same rule. At viewport
width <= 430px there is no room left of the parent (parent right edge at ~231px + 4px gap + 192px submenu + 4px margin = 431px, so it does not fit below 431px), so
the submenu instead stacks directly above the Exclude row, right-aligned with the
parent (`max-[430px]:right-0 max-[430px]:bottom-full`). Verified in a real browser
down to 320px wide.

### Hover-reveal Controls (#66)

Small per-item action buttons that live inside a list row or thumbnail (exclude-rule
remove, pick delete, history exclude-menu) must never be `opacity-0` by default —
an element only visible on `:hover` is invisible to keyboard and touch users.
Use a low resting opacity instead, brightened on hover/focus:

```
opacity-40 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity
```

### Focus Ring (#66)

`:focus-visible` only (never plain `:focus` on buttons/links, so a mouse click
doesn't draw a ring on a non-text control). Defined globally in `index.css`:

```
outline: 2px solid rgba(255,255,255,0.6);
outline-offset: 2px;
```

0.6-opacity white against the black canvas meets ~7:1 contrast (WCAG 2.4.11
non-text contrast requires 3:1). An earlier 0.15-opacity ring failed this test.

**Suppressing it on a specific element (#66レビュー3巡目should)**: the global
rule is `[tabindex]:focus-visible { outline: ...; }` — an attribute selector +
pseudo-class, specificity (0,2,0). Tailwind's plain `outline-none` utility is
just a class selector, specificity (0,1,0), so it **loses** to the global rule
and the ring still shows. Use the important-modifier `!outline-none` to force
it (confirmed in real-browser e2e). Also: Tailwind's `outline-none` doesn't set
`outline-style: none` — it sets `outline: 2px solid transparent` (kept
non-`none` on purpose, for Windows High Contrast Mode/forced-colors visibility)
— so don't check `outlineStyle`/`outlineWidth` to verify "no visible ring" in
tests; check `outlineColor` is transparent instead. `Settings`/`ShortcutsOverlay`
use this on the panel itself (see below, and `useFocusTrap`'s `openedViaMouse`).

**Focus target depends on how the modal was opened (#66レビュー3巡目should)**:
`useFocusTrap(ref, isOpen, openedViaMouse)` normally focuses the first
focusable element (the close button) on open — but a delayed
`requestAnimationFrame`-based `.focus()` call is disconnected in time from the
click that triggered it, so real Chromium can't attribute it to mouse modality
and defaults to matching `:focus-visible` anyway, drawing a ring on the close
button even when the user opened the modal with a mouse. When the caller knows
the open was mouse-triggered (`event.detail > 0` on the triggering `onClick`),
it passes `openedViaMouse={true}` and the hook focuses the **panel itself**
(`tabIndex={-1}`, `!outline-none`) instead — invisible either way, so the
mouse-vs-keyboard distinction stops mattering visually. A genuine keyboard open
(`event.detail === 0`, or the `?` key) still focuses the close button as
before, and correctly shows its ring.

### Fixed-Position Overlays Nested Inside a Transformed Ancestor (#66レビュー3巡目must)

A `position: fixed` descendant is normally sized/positioned relative to the
viewport — **unless** an ancestor has `transform`, `filter`, `backdrop-filter`,
`perspective`, or `will-change: transform` set to a non-default value, in which
case that ancestor becomes the fixed descendant's containing block instead
(CSS spec behavior, not a bug in this codebase, but easy to trip over). Two
places in this app nest a `fixed inset-0` click-to-close backdrop inside such
an ancestor:

- `OverlayUI`'s "…" menu backdrop, inside the floating bar (`-translate-x-1/2`
  transform + `backdrop-blur-md` on the bar itself)
- `HistorySection`'s per-item exclude-menu backdrop, inside the Settings
  modal's panel (a framer-motion `motion.div` with `animate={{ scale: 1 }}` —
  Motion keeps `transform: scale(1)` applied via inline style even at rest,
  which still counts as "a transform is set")

In both cases the backdrop's `inset: 0` resolved against that ancestor's own
box instead of the viewport, so clicking outside the ancestor's rectangle
(e.g. anywhere on the photo) never reached the backdrop and the menu stayed
open — a real-browser-only regression invisible in jsdom (jsdom doesn't
compute containing blocks at all). Fix: `createPortal(<backdrop/>,
document.body)` so the backdrop element is a direct child of `<body>`,
unaffected by any ancestor's transform/filter. If you add another
click-to-close-anything `fixed` element nested inside a transformed/blurred/
animated ancestor, portal it the same way.

### Charts (#67)

The stats tab's display-count distribution (`GraphSection` + `displayCountPlot.ts`,
uPlot) follows the same rule as everything else: no hue. The chart is data in
service of one question — "is every photo shown equally often?" — so it is built to
answer that at a glance and then get out of the way. The photos stay the hero.

- **Form**: a histogram (X = times shown, integer slots; Y = number of files). Fair
  shuffling shows up as one or two adjacent tall bars; bias shows up as a wide
  spread. The Y axis always starts at 0 (bars are never truncated).
- **Headline first**: three stat tiles above the plot (`bg-black/40 rounded-lg p-3`,
  label `text-xs text-white/50`, value `font-mono text-2xl text-white/80`) — shown
  at least once (with a `h-0.5` progress hairline), average times shown, fewest to
  most. A neutral pill next to the title states the verdict in words: "Even (gap of
  1 or less)" with a check icon, or "Gap of N between most and least shown". The
  verdict is a text + icon, never a color.
- **Ink** (canvas can't use Tailwind classes; these are the same white opacities):
  bars `rgba(255,255,255,0.72)`, axis numbers/labels `0.55` (clears the 4.5:1
  informational-text floor on black), horizontal grid `0.06` (recessive), mean line
  `0.9` dashed. No vertical grid, no tick marks, no legend for a single series (the
  title names it). Bars have a rounded data end (radius 0.3) and a square baseline;
  a bin that has files but would render under 2px still gets a 2px mark so it is
  never invisible.
- **Type**: `11px` Inter (same family as the UI) for axis numbers and labels. Large
  Y values are compacted (`12.5K` / `1.2万`); X ticks are integers only, thinned to
  1/2/5/10... steps.
- **Direct label**: the mean is labelled on the plot ("Avg 2.7"); no numbers on
  every bar.
- **Hover**: the hovered integer slot gets a `bg-white/10` column and a tooltip
  (`bg-black/90 rounded-lg text-xs`, "Shown 3x" / "8,400 files (70.0%)"). Empty
  slots read as "0 files" — gaps are information. The tooltip is HTML, not canvas.
- **Accessibility**: the chart host is `role="img"` with a translated summary
  `aria-label`; a "View as table" `<details>` lists every bin (count / files /
  share). The chart follows the modal width via `ResizeObserver`.
- **Not applicable**: dark-only app, so there is no light-mode palette; the
  categorical/status palette rules don't apply because the chart is a single
  monochrome series.

## 5. Layout Principles

### Container

- Full viewport: `w-screen h-screen`
- No max-width constraint (desktop app fills window)

### Spacing Scale

| Token             | Value         |
| ----------------- | ------------- |
| Icon pill pad     | `p-1` (4px)   |
| Icon button pad   | `p-2` (8px)   |
| Close button      | `p-1.5` (6px) |
| Cell content      | `p-2` (8px)   |
| Form inputs       | `p-3` (12px)  |
| Panel content     | `p-4` (16px)  |
| Modal padding     | `p-7` (28px)  |
| Heading → desc    | `mt-1` (4px)  |
| Desc → control    | `mt-4` (16px) |
| Section → section | `space-y-8`   |

### Floating Bar Layout (#66)

The bottom overlay and the top-right chrome are both flex-based pill/bar
containers now, not CSS grids with hairline dividers between cells. See
"Floating Control Bar" and "Icon Pill Group" above for the exact classes —
there's no separate grid system to document.

### Key Dimensions

- Modal: `max-w-2xl w-full mx-8`, `max-h-[76vh]` (content area has no min-height
  at all — #66/#66レビューshould: it fully tracks content, shrinking for short
  tabs and scrolling past `max-h-[76vh]` for long ones, instead of always
  reserving half the screen). The backdrop uses `items-start justify-center
pt-[12vh]` rather than vertical centering (#66レビュー2巡目should2): with a
  content-tracking height, centering means the header/tab row physically move
  up and down every time you switch tabs (a short tab centers higher, a tall
  one lower). Anchoring the top edge at a fixed `pt-[12vh]` keeps the header
  and tab row pinned in place; only the bottom edge moves as content grows or
  shrinks. `76vh` (rather than `80vh`) leaves a roughly symmetric ~12vh margin
  at the bottom too
- Floating control bar: `w-[calc(100%-2rem)] max-w-xl` (#66)
- Icon sizes: `w-4 h-4` (16px) standard, `w-5 h-5` (20px) for the center
  play/pause emphasis

## 6. Depth & Elevation

### Blur Effects

- `backdrop-blur-md` — main UI overlay, modals
- `backdrop-blur-sm` — submenus

### Shadows

Minimal. Glassmorphism relies on blur, not shadows.

- `shadow-2xl` — submenus, modal, floating control bar, icon pill group (#66)
- `drop-shadow-lg` — map icon hover
- Cards/panels: none (background contrast only, #66 — see "Panels & Cards")

### Border Radius (#66)

| Context                         | Radius               |
| ------------------------------- | -------------------- |
| Small tags/badges               | `rounded` (4px)      |
| Buttons, inputs, cards          | `rounded-lg` (8px)   |
| Floating control bar, dropdowns | `rounded-2xl` (16px) |
| Modal, notice cards             | `rounded-2xl` (16px) |
| Icon pill groups, status pills  | `rounded-full`       |

Everything that is a clickable control or a data container uses `rounded-lg`;
everything that is a floating/glass surface (bars, dropdowns, modals, pills)
uses `rounded-2xl` or `rounded-full`. Two shapes, not a spectrum — the old
`rounded` (4px) survives only for tiny inline badges (the date-rule tag, the
`?`/`Esc` key badges).

### Scrollbar

- Width: thin
- Track: transparent
- Thumb: `rgba(255,255,255,0.1)`, hover `rgba(255,255,255,0.2)`
- Border radius: 2px

## 7. Do's and Don'ts

### Do

- Use only black/white at varying opacity. The monochrome constraint is absolute
  (a solid white-fill Primary button is still black/white — it's opacity as a
  _background_ rather than as _text_, not a new hue)
- Apply `backdrop-blur-md` to all panels overlaying photo content
- Use `font-mono` for numerical data, file paths, and timestamps that remain
  visible in the UI (#66: several of these moved into `title` tooltips instead
  of being always-visible — see "Floating Control Bar")
- Prefer a background-contrast difference over a border for grouping (#66 —
  see "Panels & Cards"). Keep borders for floating surfaces (modals, dropdowns,
  the control bar, input fields) and genuinely bare-black elements
- Use `transition-colors` for hover states
- Make _interactive_ icons legible by default (`text-white/60`, hover `/90`,
  #66) — only genuinely passive/decorative glyphs stay faint (`/20`–`/30`)
- Only ever have one Primary (white-fill) button per screen; everything else is
  Standard or Ghost
- Only show information that's actually present — no "No date" / "No location"
  placeholder boxes for absent EXIF data (#66)
- Set `pointer-events: none` on idle UI (`opacity: 0` when idle)

### Don't

- Add colorful accent colors. Red-400/80 is only for errors/destructive actions
- Use thick borders or strong box-shadows
- Create large, dramatic buttons or hover effects
- Add a light theme
- Import custom fonts beyond Inter
- Use opacity values outside standard increments (/5, /8, /10, /15, /20, /25, /30, etc.).
  Tailwind 3.4's own opacity scale is 5-step (0, 5, 10, ..., 95, 100) — `/8` is the
  one value on this list that isn't a multiple of 5 (besides the background logo's
  `opacity-2`, #99), and they're only usable because `tailwind.config.js` adds
  `theme.extend.opacity: { 2: '0.02', 8: '0.08' }` explicitly
  (#66レビューmust3: without that entry, `border-white/8`/`bg-white/8` silently
  generate no CSS at all and fall back to Preflight's default `border-color:
currentColor`, rendering a visibly brighter border than intended). Adding any
  further non-multiple-of-5 value here requires the same `tailwind.config.js`
  addition, verified against the built `dist/assets/*.css`
- Reach for `rounded` (4px) on anything but a tiny inline badge — buttons/cards
  are `rounded-lg`, floating surfaces are `rounded-2xl`/`rounded-full` (#66)

### Transitions

| Context           | Duration | Timing                    |
| ----------------- | -------- | ------------------------- |
| Color transitions | 300ms    | default                   |
| Custom duration   | 400ms    | defined in Tailwind       |
| Image transitions | 500ms    | easeInOut (Framer Motion) |
| Modal open/close  | 200ms    | default                   |

## 8. Responsive Behavior

This is a Tauri desktop app — no mobile breakpoints. The UI adapts to window resize via flex/grid.

### Idle State

- UI fades to `opacity: 0` after idle timeout (300ms transition)
- `pointer-events: none` when hidden
- Mouse movement restores UI
- The top-right button row (exit, shortcuts, window mode, settings) fades with the
  same rule as the bottom overlay — it must never stay solid while the overlay is
  hidden (#66). Shared via `idleFadeClassName()` in `constants.ts`
- `has-[:focus-visible]:opacity-100` on both fading containers keeps them visible
  while a keyboard user has tabbed into a control inside — a focused-but-invisible
  element is a focus-visibility failure, not just a visual nit. **Not**
  `focus-within:` (#66レビューmust2(a)): in real Chromium/WebView2, a plain mouse
  click leaves DOM focus on the clicked button, which keeps `focus-within` true
  forever and the bar never fades on idle even though the user isn't interacting
  with it. `:focus-visible` only matches focus that the browser attributes to
  keyboard/intentional navigation, so mouse-click residue correctly stops
  counting as "still in use"
- The mouse cursor itself hides (`cursor-none`) on the same idle timeout while the
  slideshow is showing (not while the Settings modal or the Shortcuts overlay is
  open, #66レビューshould) — a photo-viewing app should not leave a static cursor
  sitting on top of the image (#66)
- Every `<button>` inside the floating bar and the top-right pill has its own
  `onMouseDown={createButtonFocusGuard(containerRef)}` (`lib/keyboardShortcuts.ts`,
  #66レビュー2巡目must1 → 3巡目nit): `preventDefault()` stops the click from
  giving that button focus at all (so a later keypress can't flip a residual
  click-focus into `:focus-visible`, see must2(a) above). This guard is attached
  **per button**, not on the container (an earlier version put it on the
  container and accidentally also blocked drag-selecting the filename text).
  The same handler also `blur()`s whatever OTHER element inside the container
  currently holds real keyboard focus (e.g. Tab-focused a moment ago) — without
  this, clicking a different button doesn't touch that stale focus at all (since
  `preventDefault()` stops the new button from stealing it), so it would linger
  and keep `has-[:focus-visible]` true forever, and the bar would never fade

### Touch Targets

Not applicable (desktop only). Icon buttons are `p-2` (32px touch area).

## 9. Agent Prompt Guide

### Full Color Reference

```
Backgrounds:  bg-black, bg-black/20 through bg-black/90
Text:         text-white/15 through text-white/80
Borders:      border-white/5, /8, /10, /20
Error only:   text-red-400/80
```

### When generating UI for this project

- Pure monochrome. Black background, white text/fills at opacity. Zero hue
- Glassmorphism via `backdrop-blur-md` on overlays. This is the primary depth cue
- UI must be invisible when idle (including the cursor and the top-right chrome
  pill, #66). Photo content is always the star
- Inter font only, loaded offline. `font-mono` for data that stays on-screen
- Icons from Lucide React, small (14-20px). Interactive icons default to
  `text-white/60` (hover `/90`, #66) — legible without hovering first. Only
  passive/decorative glyphs stay faint (`/20`–`/30`)
- Two radius families (#66): `rounded-lg` (8px) for buttons/inputs/cards,
  `rounded-2xl`/`rounded-full` for floating surfaces (bars, modals, pills,
  dropdowns). `rounded` (4px) survives only for tiny inline badges
- Prefer background-contrast over borders for grouping list rows/cards (#66)
- One Primary (white-fill) button per screen at most; the rest are Standard/Ghost
- Don't render a placeholder for information that isn't there (#66)
- No gradients, no colored accents, no decorative elements
- Framer Motion for image transitions (500ms easeInOut)
- `transition-colors` for hover states (300ms)

### Opacity Emotion Reference

- **80%:** Active, readable, primary — "I'm here"
- **50%:** Present but quiet — section headers, labels
- **30%:** Whisper — disabled, helper text
- **10%:** Ghost — borders, barely-there dividers
- **5%:** Invisible infrastructure — grid lines
