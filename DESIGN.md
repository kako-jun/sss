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

### Buttons — Standard

```
bg-white/8 hover:bg-white/15
text-white/60 hover:text-white/80
border border-white/8
rounded
transition-colors text-sm
```

### Buttons — Disabled

```
bg-black/20
disabled:text-white/20 disabled:border-white/5
disabled:opacity-30 disabled:cursor-not-allowed
```

### Buttons — Icon

```
text-white/30 hover:text-white/60
hover:bg-white/5
p-2 rounded
```

### Buttons — Ghost

```
text-white/20 hover:text-white/50
(no background)
```

### Input Fields

```
bg-black/40 text-white/60
rounded border border-white/8
focus:outline-none focus:border-white/20
px-3 py-2 text-sm
placeholder: text-white/30
```

### Range Sliders

```
h-1 bg-white/10 rounded-lg accent-white/60
```

### Checkboxes

```
w-4 h-4 rounded border-white/20
bg-white/5 accent-white/50
```

### Panels & Cards

```
Standard:  bg-black/40 rounded border border-white/8
Info:      bg-black/30 rounded border border-white/5
Dark:      bg-black/80 rounded border border-white/8
Modal:     bg-neutral-950 rounded-xl border border-white/8 shadow-2xl
```

### Submenus/Dropdowns

```
bg-black/90 rounded shadow-xl border border-white/8
p-2 space-y-1 backdrop-blur-sm
```

## 5. Layout Principles

### Container

- Full viewport: `w-screen h-screen`
- No max-width constraint (desktop app fills window)

### Spacing Scale

| Token           | Value         |
| --------------- | ------------- |
| Icon button pad | `p-1` (4px)   |
| Close button    | `p-1.5` (6px) |
| Cell content    | `p-2` (8px)   |
| Form inputs     | `p-3` (12px)  |
| Panel content   | `p-4` (16px)  |
| Modal padding   | `p-7` (28px)  |

### Grid

- Bottom info overlay: `grid grid-cols-4 gap-px`
- Bottom controls: `grid grid-cols-5 gap-px`
- `gap-px` = 1px borders between cells

### Key Dimensions

- Modal: `max-w-2xl w-full mx-8`
- Icon sizes: `w-4 h-4` (16px), `w-5 h-5` (20px)

## 6. Depth & Elevation

### Blur Effects

- `backdrop-blur-md` — main UI overlay, modals
- `backdrop-blur-sm` — submenus

### Shadows

Minimal. Glassmorphism relies on blur, not shadows.

- `shadow-xl` — submenus
- `shadow-2xl` — modal
- `drop-shadow-lg` — map icon hover
- Cards/panels: none (border only)

### Border Radius

| Context  | Radius              |
| -------- | ------------------- |
| Standard | `rounded` (4px)     |
| Modal    | `rounded-xl` (12px) |

### Scrollbar

- Width: thin
- Track: transparent
- Thumb: `rgba(255,255,255,0.1)`, hover `rgba(255,255,255,0.2)`
- Border radius: 2px

## 7. Do's and Don'ts

### Do

- Use only black/white at varying opacity. The monochrome constraint is absolute
- Apply `backdrop-blur-md` to all panels overlaying photo content
- Use `font-mono` for all numerical data, file paths, and timestamps
- Keep borders thin (`border-white/8` or `/10`)
- Use `transition-colors` for hover states
- Make icons faint by default (`text-white/20` to `/40`) and brighten on hover
- Set `pointer-events: none` on idle UI (`opacity: 0` when idle)

### Don't

- Add colorful accent colors. Red-400/80 is only for errors
- Use thick borders or strong box-shadows
- Create large, dramatic buttons or hover effects
- Add a light theme
- Import custom fonts beyond Inter
- Use opacity values outside standard increments (/5, /8, /10, /15, /20, /25, /30, etc.)

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

- Pure monochrome. Black background, white text at opacity. Zero hue
- Glassmorphism via `backdrop-blur-md` on overlays. This is the primary depth cue
- UI must be invisible when idle. Photo content is always the star
- Inter font only, loaded offline. `font-mono` for data
- Icons from Lucide React, small (14-18px), faint (`text-white/20` to `/40`)
- Rounded corners are minimal: `rounded` (4px) standard, `rounded-xl` (12px) for modals
- No gradients, no colored accents, no decorative elements
- Framer Motion for image transitions (500ms easeInOut)
- `transition-colors` for hover states (300ms)

### Opacity Emotion Reference

- **80%:** Active, readable, primary — "I'm here"
- **50%:** Present but quiet — section headers, labels
- **30%:** Whisper — disabled, helper text
- **10%:** Ghost — borders, barely-there dividers
- **5%:** Invisible infrastructure — grid lines
