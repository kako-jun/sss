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

### Range Sliders

```
h-1 bg-white/10 rounded-lg accent-white/60
```

### Checkboxes

```
w-4 h-4 rounded border-white/20
bg-white/5 accent-white/50
```

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

### Settings Section Rhythm (#66)

Every settings tab is a vertical stack of sections (`space-y-8` between them).
Each section itself follows the same three-part rhythm:

```
<div>
  <h3 className="text-sm font-medium text-white/70">{heading}</h3>
  <p className="text-xs text-white/40 mt-1">{description}</p>  {/* optional */}
</div>
<div className="mt-4">{control(s)}</div>          {/* via the outer space-y-4 */}
```

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

- Modal: `max-w-2xl w-full mx-8`, `max-h-[80vh]` (content area has no min-height
  at all — #66/#66レビューshould: it fully tracks content, shrinking for short
  tabs and scrolling past `max-h-[80vh]` for long ones, instead of always
  reserving half the screen)
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
  one value on this list that isn't a multiple of 5, and it's only usable because
  `tailwind.config.js` adds `theme.extend.opacity: { 8: '0.08' }` explicitly
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
