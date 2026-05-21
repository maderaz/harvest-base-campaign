# Harvest design system

Self-contained handoff bundle for porting the Harvest visual language to a fresh
codebase. Read this end-to-end before touching any of the CSS files - the
naming conventions and the light/dark scoping mechanism only make sense once
you've internalised the palette.

If you are an AI building a new project: this document plus the three CSS files
in this folder (`tokens.css`, `components.css`, `darkmode.css`) is all you need
to recreate the design. Drop the CSS in your `globals.css`, follow the class
naming conventions below, and you'll get something that reads as the same
product.

---

## 1. The palette

Five-colour brand, picked to read as "credible financial data with a single
warm accent". One gold, two ink ramps, two paper ramps.

| Role | Light hex | Dark hex | Notes |
| --- | --- | --- | --- |
| **Sunflower Gold** | `#ffb936` | `#ffb936` | The single accent. Reserved for active state, the "you are here" highlight, primary CTA, focused tab. Never use for body copy. |
| Gold soft | `#ffd98a` | `#ffd98a` | Hover-fade on the gold CTA. |
| Gold bg | `#fff5d9` | `rgba(255, 185, 54, 0.18)` | Subtle gold-tinted background for chips and active rows. |
| **Onyx** (ink) | `#191717` | `#f4f4f1` | Primary text + dark UI fills. Light theme: ink. Dark theme: paper. |
| **Graphite** (ink-2) | `#32312b` | `#d4d2cc` | Body text + secondary labels. WCAG-AA on every surface. |
| Ink-3 | `#6e6c66` | `#9a9892` | Tertiary text. Use only for chip-sized labels (<=12px). |
| Ink-4 | `#9a9a94` | `#6a6862` | Disabled state, very tertiary. Don't use on body copy. |
| **Alabaster Grey** (line) | `#dddee0` | `#2f2e2a` | Default hairline border. |
| Line-2 | `#ebebe7` | `#3a3833` | Subtle dividers inside cards. |
| **White Smoke** (card) | `#f1f5f4` | `#232220` | Card / panel surface. |
| Card-2 (elevated) | `#ffffff` | `#2a2825` | Hovered or elevated card surface. |
| Background | `#FFFFFF` | `#1a1917` | Page background. |

Light theme is the canonical mode. Dark theme is a 1:1 token swap (see Section
4). Never write a colour as a hex anywhere outside of `tokens.css`; every
component reads from a variable.

---

## 2. Typography

Three Google fonts, self-hosted via `next/font` (or the equivalent in your
framework so the browser doesn't make a third-party request).

| Family | CSS var | Weights | Used for |
| --- | --- | --- | --- |
| **Inter** | `--sans` | 400, 500, 600 | Body text, labels, paragraphs. |
| **Inter Tight** | `--display` | 500, 600, 700 | Hero h1, section h2, stat numbers, ranking values. Tighter letter-spacing than Inter so big sizes read as a display face. |
| **JetBrains Mono** | `--mono` | 400, 500 | Numeric columns, code chips, slug links, session IDs. `font-feature-settings: "tnum"` everywhere a column of numbers needs to align. |

### Scale

| Token | Size | Weight | Use |
| --- | --- | --- | --- |
| Display XL | `clamp(28px, 3.4vw, 38px)` | 600 (`--display`) | Hub page h1 |
| Display L | 32px | 600 (`--display`) | Hero h1 on product page |
| Display M | 22px | 600 (`--display`) | Section title (h2) |
| Body L | 16px | 400 (`--sans`) | Lede paragraph |
| Body | 15px | 400 (`--sans`) | Default body |
| Body S | 14px | 500 (`--sans`) | Labels, captions |
| Small | 12.5px | 500 (`--sans`) | Stat labels, secondary meta |
| Mono | 12-13px | 400 (`--mono`) | Slugs, code, session ids |

Letter-spacing: display tokens use `-0.012em` to `-0.022em` (tightened as the
font scales up). Body tokens are 0.

---

## 3. Spacing and radii

| Token | Value | Use |
| --- | --- | --- |
| `--uni-radius` | 20px | Cards, table-wraps, modal surfaces |
| `--uni-radius-sm` | 14px | Stat tiles, small surfaces |
| `--uni-radius-pill` | 999px | Pills, buttons, chips |

Spacing rhythm (in pixels): **4, 6, 8, 10, 12, 14, 18, 22, 28, 36, 56**.
Section-to-section gap is 56px. Card padding is typically 22-24px. Stat tile
padding is 14-16px. Row padding inside a hub table is 18px vertical / 22px
horizontal.

---

## 4. Light and dark theme

The pattern is a `data-theme` attribute on `<html>` that toggles a CSS variable
swap. No client JS needed at runtime once the variables are switched. A tiny
synchronous script in `<head>` reads `localStorage.getItem('theme')` (or the
OS `prefers-color-scheme` media query) and sets the attribute *before* the
body paints, so users never see a flash of the wrong theme.

```js
// Inline this script in <head> before any stylesheet links.
(function () {
  try {
    var s = localStorage.getItem('theme');
    var t = s === 'dark' || s === 'light'
      ? s
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
```

Every component reads from CSS variables. The dark theme just overrides those
variables under `:root[data-theme="dark"]`. See `darkmode.css`.

The gold accent (`#ffb936`) stays the same in both modes - it's the brand
anchor, the one colour you don't flip.

---

## 5. Class-naming convention

Two scopes, picked for surface specificity:

- `.uni-shell` - the single-product page (one product per page). Component
  classes inside this scope are prefixed `.uni-` (e.g. `.uni-title-row`,
  `.uni-side-card`, `.uni-cta`). Read this as "universal product shell".
- `.uni-hub-test` - hub pages (asset listings, network listings, admin pages
  built on the same shell). Component classes inside this scope are prefixed
  `.uni-hub-` (e.g. `.uni-hub-hero`, `.uni-hub-stat`, `.uni-hub-section`).
- Shared ranking-table components (used on any page that lists products) are
  prefixed `.hub-` (no `uni-`), e.g. `.hub-table-wrap`, `.hub-thead`,
  `.hub-row`, `.hub-cell`, `.hub-strategy`, `.hub-num`.

The scoping matters: the same class name (`.hub-table` for instance) reads
from `.hub-table-wrap` variables (`--hub-ink`, `--hub-bg`), which are scoped
under that wrapper. This means a hub table on a dark admin page picks up the
dark variables automatically without any per-cell overrides.

When you port: keep the prefixes. They're load-bearing because the dark mode
overrides target them. Renaming `.uni-hub-test` to e.g. `.page-shell` means
you also need to update every `.uni-hub-test .x` selector and the
`:root[data-theme="dark"] .uni-hub-test` block.

---

## 6. Component patterns

### 6.1 Hub table (the ranking pattern)

The flagship pattern. Used on every list page (asset hub, network hub, search
results, admin tables). CSS Grid table - no `<table>` element, every row is a
grid container with the same `grid-template-columns` so cells align without
needing a real table layout.

```html
<div class="hub-table-wrap">
  <div class="hub-table" role="table">
    <div class="hub-thead" style="grid-template-columns: 50px 2fr 1fr 0.5fr 110px">
      <span class="hub-th hub-th-rank">#</span>
      <span class="hub-th">Vault</span>
      <span class="hub-th hub-th-right">APY</span>
      <span class="hub-th hub-th-center">Chain</span>
      <span class="hub-th">Trend</span>
    </div>
    <div class="hub-row" role="row" style="grid-template-columns: 50px 2fr 1fr 0.5fr 110px">
      <span class="hub-cell hub-rank">1</span>
      <span class="hub-cell hub-vault">
        <img src="..." width="22" height="22" alt="USDC" />
        <span class="hub-vault-name">USDC Aave</span>
      </span>
      <span class="hub-cell hub-num">5.42%</span>
      <span class="hub-cell hub-network">...</span>
      <span class="hub-cell hub-spark hub-spark-up">...</span>
    </div>
    <!-- more rows -->
  </div>
</div>
```

- `hub-row` hover: gold tint at 6% alpha
- `hub-vault-name`: 16px, weight 600, `--display` font
- `hub-num`: right-aligned, `--display` font, `font-feature-settings: "tnum"`
- `hub-spark`: 100x32px inline svg, `currentColor` so theme flip propagates
- Mobile: tables horizontally scroll inside `.hub-table-wrap` (overflow-x:
  auto) rather than reflowing columns, because admin tables carry
  unique-per-row data we can't drop.

### 6.2 Stat tile

The repeatable headline-number block in heroes.

```html
<div class="uni-hub-stat">
  <div class="uni-hub-stat-label">Total products</div>
  <div class="uni-hub-stat-value">161</div>
</div>
```

- Surface: `--uni-card` background, `--uni-radius-sm` corner
- Value: 22px, weight 600, `--display`, `-0.014em` letter-spacing
- Label: 12.5px, weight 500, `--sans`, `--uni-ink-2`
- Grid: `uni-hub-stats { display: grid; grid-template-columns: repeat(N, 1fr); gap: 10px }` - typical N is 4 on desktop, 2 on mobile.

### 6.3 Pills and chips

Three flavours, all with the same shape but different fill semantics:

- **Type pill** (filled): solid colour, white or onyx text. Reserved for "what kind of thing is this" categorisation. Each category gets a distinct solid colour - gold for Home, green for Asset, indigo for Network, onyx for Product.
- **Status pill** (tinted): low-alpha background + saturated text. Reserved for "what state is this in". OK/positive = green tint, warn/red tint = error.
- **Tag chip** (outlined): transparent background, hairline border. Reserved for filter values and selectable categories.

Pill metrics: padding 2-3px vertical / 9-10px horizontal, font 10.5-11px,
weight 600-700, letter-spacing 0.02em, border-radius 999px.

### 6.4 Hero section

Single grid: headline column + (optional) stat grid column. Border-bottom
hairline, 32px bottom margin. On mobile this collapses to a single column at
1100px.

```html
<header class="uni-hub-hero">
  <div class="uni-hub-hero-headline">
    <h1 class="uni-hub-h1">Page title</h1>
    <p class="uni-hub-sub">One-paragraph framing, 60ch max, body-2 colour.</p>
  </div>
  <div class="uni-hub-stats" style="grid-template-columns: repeat(4, 1fr)">
    <!-- stat tiles -->
  </div>
</header>
```

### 6.5 Section header

Title + meta line, with a 56px gap above (the section spacing rhythm).

```html
<section class="uni-hub-section">
  <header class="uni-hub-section-head">
    <h2 class="uni-hub-section-title">Section title</h2>
    <span class="uni-hub-section-meta">mono caption, --uni-ink-2</span>
  </header>
  <!-- section content -->
</section>
```

### 6.6 Primary CTA

Solid gold pill with onyx text. The only place gold-as-background appears
outside of charts.

```html
<a class="uni-cta" href="...">
  View Strategy
  <svg class="uni-cta-icon">...</svg>
</a>
```

- Background: `var(--uni-gold)` (`#ffb936`)
- Color: `var(--uni-ink)` (`#191717`)
- Hover: slight `filter: brightness(0.96)` + gold-glow `box-shadow`
- Active: `transform: translateY(1px)` for tactile press

---

## 7. Charts and data viz

Bars and lines render in the brand gold (`#ffb936`) for "up / good" series,
graphite (`--uni-ink-3`) for muted / flat series, and a dotted background
plot pattern (radial-gradient dots, 20px grid) to give the empty chart area
weight. Chart cards are always white surface, never tinted.

Axis labels: 12px mono, `--uni-ink-3`. Hover state: bar lifts slightly via
`filter: brightness(0.92)`. Tooltip: solid onyx pill, white text.

Outliers (broken data points, e.g. a corrupted snapshot): rendered in red
`#c0322a` instead of gold so the operator instantly spots them.

---

## 8. Editorial constraints

These are content rules but they shape layout decisions.

- **No em dash** (`—`, U+2014) anywhere in user-facing copy. Use a comma,
  colon, period, or " - " (hyphen with spaces). This applies to headings,
  body, labels, tooltips, FAQ answers, breadcrumbs - everything visible. The
  em dash is fine in code comments and PR descriptions.
- **Coverage claims** (ranking sentences, "across the network", "of N
  strategies") must signal that the population is what we track, not the
  whole market. Phrase with "we monitor", "in our index", "the strategies we
  follow" at least once per section.
- Avoid superlatives and outperformance percentages without scoping.

---

## 9. Integration recipe

In a fresh Next.js / Vite / static project:

1. Copy `tokens.css`, `components.css`, `darkmode.css` from this bundle into
   your project's CSS directory.
2. Import them in this order in your root stylesheet:
   ```css
   @import "./tokens.css";
   @import "./components.css";
   @import "./darkmode.css";
   ```
3. Load Inter, Inter Tight, JetBrains Mono via your font system. Bind them
   to `--sans`, `--display`, `--mono`. With `next/font`:
   ```ts
   const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter", display: "swap" });
   const interTight = Inter_Tight({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-inter-tight", display: "swap" });
   const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains-mono", display: "swap" });
   // Then in <html> className: `${inter.variable} ${interTight.variable} ${jetbrainsMono.variable}`
   ```
4. Inline the dark-mode resolver script in `<head>` (see Section 4) so the
   theme attribute is set before paint.
5. Wrap your top-level page content in `.uni-hub-test` (for list / hub pages)
   or `.uni-shell` (for single-item detail pages). The token + component CSS
   targets these scopes.
6. Use the component patterns in Section 6 as your starting templates. Every
   colour, every spacing token, every font reads from a CSS variable - don't
   hardcode.
7. To audit: open one page in light mode, toggle `data-theme="dark"` on
   `<html>` via devtools. Nothing should remain stuck on its light-mode hex;
   if it does, you have a hardcoded colour that needs to move into the
   token system.
