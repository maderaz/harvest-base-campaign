# Charts and data visualization

How charts look across harvest.finance. Three families: bar charts (admin
acquisition + product page TVL/APY), line charts (product page time series,
multi-metric overlay), and sparklines (ranking tables). One palette, one
geometric language, no charting library - everything is hand-rolled CSS-grid
and inline SVG so the bundle stays tiny and the visuals stay consistent.

If you are an AI rebuilding the visualization layer in a new project: this
document plus the matching `charts.css` snippet at the bottom is enough to
recreate the look. No d3, no recharts, no chart.js needed.

---

## 1. Visual language

| Trait | Value | Why |
| --- | --- | --- |
| **Primary series colour** | Sunflower Gold `#ffb936` | The same accent used across the rest of the product. Charts read as "Harvest gold" before they read as data. |
| **Muted series colour** | Graphite `--ink-3` | Used for flat / down-trending sparklines and for axis labels. |
| **Outlier / error colour** | Red `#c0322a` | Reserved for corrupted data points (e.g. a $1B+ snapshot artefact). One glance and the operator knows. |
| **Plot background** | Dotted radial-gradient grid | 1px dots on a 14px square grid at `--tint-strong` alpha. Gives the empty plot area weight without lines that compete with bars. |
| **Surface around chart** | Card-2 white (`var(--card-2)`) | Chart card sits on the page like a sheet of paper. Never tinted. |
| **Inner plot border** | Hairline `--line-2` | Makes the plot bounds obvious on sparse data (single tall bar + 29 stubs would otherwise look "empty"). |
| **Corner radii** | 5px on bar tops, 14px on inner plot, 20px on outer card | The 5px on bars is the only place we use a non-token radius - it's small enough to read as soft rather than rounded. |

The gold-on-dotted-white treatment is the signature. Recreate that and 80% of
the look comes with it.

---

## 2. Chart card chrome

The repeatable outer container that wraps every chart - bignum headline plus
plot area plus axis.

```html
<div class="chart-card">
  <div class="chart-bignum">12,847</div>
  <div class="chart-bignum-label">
    visits indexed across the trailing 30 days
  </div>

  <div class="chart-plot">
    <div class="chart-bars">
      <!-- bars or line svg here -->
    </div>
    <div class="chart-axis">
      <span>30d ago</span>
      <span>15d ago</span>
      <span>today</span>
    </div>
  </div>
</div>
```

```css
.chart-card {
  background: var(--card-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 28px 32px;
  margin-bottom: 32px;
}
.chart-bignum {
  font-family: var(--display);
  font-size: 44px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.022em;
  color: var(--ink);
  font-feature-settings: "tnum";
}
.chart-bignum-label {
  margin-top: 8px;
  font-size: 15px;
  color: var(--ink-2);
}
.chart-plot {
  margin-top: 28px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 300px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius-sm);
  padding: 16px 14px 12px;
  background-image: radial-gradient(
    circle,
    var(--tint-strong) 1px,
    transparent 1.4px
  );
  background-size: 14px 14px;
  background-position: 0 100%;
}
.chart-axis {
  display: flex;
  justify-content: space-between;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-3);
  font-weight: 500;
  padding: 2px 2px 0;
}
@media (max-width: 720px) {
  .chart-card { padding: 20px 18px; }
  .chart-bignum { font-size: 32px; }
  .chart-bignum-label { font-size: 13.5px; }
  .chart-plot { height: 200px; }
}
```

The bignum + label + plot stack is intentional - the headline answers the
"what is this chart about" question before the eye reaches the plot. Don't
hide the bignum behind the chart.

---

## 3. Bar chart

CSS Grid + flex, no SVG. Each bar is a `<div>` rooted at the baseline of the
plot. Heights are inline-styled percentages because the data drives them at
runtime.

```html
<div class="chart-bars">
  <div class="bar-col" title="42 visits (3 days ago)">
    <div class="bar" style="height: 78%"></div>
  </div>
  <div class="bar-col" title="0 visits (2 days ago)">
    <div class="bar" style="height: 4%"></div>
  </div>
  <!-- ...one bar-col per day -->
</div>
```

```css
.chart-bars {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 3px;
  position: relative;
}
.bar-col {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
}
.bar {
  width: 100%;
  background: var(--gold);
  border-radius: 5px 5px 0 0;
  /* Even zero-value bars get a 4px stub so the day reads as
     "we measured it and it was zero" not "we have no data". */
  min-height: 4px;
  transition: filter 0.12s ease;
}
.bar-col:hover .bar {
  filter: brightness(0.92);
}
.bar.is-outlier { background: #c0322a; }
```

Key load-bearing decisions:

- **Parent uses `align-items: stretch`** so each `.bar-col` fills the full
  plot height. Each `.bar-col` then uses `align-items: flex-end` internally
  to anchor its bar to the bottom. Setting `flex-end` on the parent
  collapses the bar-cols to content height and your percentage heights
  resolve against 0px - the dreaded invisible chart.
- **`min-height: 4px` on the bar** keeps zero-value days as readable stubs
  on the baseline. Without it the bar disappears entirely and the day reads
  as "no data" rather than "zero".
- **`min-height: 0` on `.chart-bars`** lets the parent flexbox shrink it
  past content height; otherwise the bar percentages resolve against the
  content height of `.chart-bars` which is the height of zero bars = 0.
- **Hover via `filter: brightness(0.92)`** instead of background change so
  the gold-vs-red outlier distinction is preserved on hover.

For mobile tooltips: render a separate hovered-bar caption above the chart
(swap the `chart-bignum` text to the hovered day's value) rather than
relying on `title` attributes which don't show on touch.

---

## 4. Line chart (time series)

Inline SVG with two paths: a fill area below the line at 8% alpha, and the
line itself on top. One viewBox at `0 0 1000 300` and let the wrapping div
scale it.

```html
<div class="chart-plot">
  <svg
    viewBox="0 0 1000 300"
    preserveAspectRatio="none"
    class="line-chart-svg"
    role="img"
    aria-label="APY over time"
  >
    <!-- gradient for the area fill -->
    <defs>
      <linearGradient id="line-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"  stop-color="#ffb936" stop-opacity="0.32" />
        <stop offset="100%" stop-color="#ffb936" stop-opacity="0" />
      </linearGradient>
    </defs>
    <!-- area: M start L points... L endX endY L startX endY Z -->
    <path d="..." fill="url(#line-fill)" />
    <!-- line -->
    <path
      d="..."
      fill="none"
      stroke="#ffb936"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
  <div class="chart-axis">...</div>
</div>
```

```css
.line-chart-svg {
  width: 100%;
  height: 100%;
  display: block;
}
```

Key decisions:

- `preserveAspectRatio="none"` so the line stretches with the container.
  Combined with `vector-effect="non-scaling-stroke"` the stroke stays a
  constant pixel width regardless of how much the container scales.
- Gradient at the *top* of the area, falling to transparent. Anchors the
  line visually without making the plot feel solid.
- 2px stroke width. Anything thinner reads as scratchy on mobile retina;
  anything thicker reads as a button.

Multi-metric overlay (e.g. APY + TVL on the same chart): use a second path
in a distinct hue from the palette - `oklch(0.62 0.16 245)` (blue) is the
canonical second-series colour. Render the second path at 1.5px stroke so
the gold primary stays the dominant signal.

---

## 5. Sparklines (ranking table)

Inline SVG, 100x32px, fits inside one cell of the ranking grid. No fill,
just a single stroke that uses `currentColor` so the parent cell colours it.

```html
<span class="hub-cell hub-spark hub-spark-up">
  <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100" height="32">
    <path
      d="M0 50 L20 40 L40 45 L60 30 L80 35 L100 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</span>
```

```css
.hub-spark { display: inline-flex; justify-content: flex-end; }
.hub-spark svg { display: block; }
.hub-spark-up   { color: var(--gold); }
.hub-spark-flat { color: var(--ink-3); }
```

Up-trending sparklines are gold; flat / down sparklines are graphite. The
classification is intentional: gold says "this is performing"; graphite
says "this is stable / declining" without yelling "danger" (we don't use
red for normal performance variance, that's reserved for actual corruption).

---

## 6. Tooltip on bar hover

Single onyx pill, white text, sits above the hovered bar. Pure CSS via
`::after` on the bar-col with a `data-tooltip` attribute - no JS needed.

```html
<div class="bar-col" data-tooltip="42 visits (3 days ago)">
  <div class="bar" style="height: 78%"></div>
</div>
```

```css
.bar-col { position: relative; }
.bar-col[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translate(-50%, 4px);
  z-index: 50;
  padding: 6px 10px;
  background: var(--ink);
  color: #ffffff;
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  border-radius: 8px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.08s ease, transform 0.08s ease;
}
.bar-col:hover[data-tooltip]::after {
  opacity: 1;
  transform: translate(-50%, 0);
}
```

The 4px translate on hover gives the tooltip a subtle "slide in from below"
motion. Don't use `display: none` to hide it - that kills the transition.
`opacity: 0` + `pointer-events: none` does the same thing without the jank.

---

## 7. Reduced motion + dark mode

For users with `prefers-reduced-motion: reduce`:

```css
@media (prefers-reduced-motion: reduce) {
  .bar { transition: none; }
  .bar-col[data-tooltip]::after { transition: opacity 0.08s; transform: translate(-50%, 0); }
}
```

For dark mode: the chart inherits `--card-2` and `--line-2` from the dark
token swap automatically. The gold accent stays the same (it's the brand
anchor). The only thing that needs a tweak is the dotted-grid alpha, which
is already handled by the `--tint-strong` token being defined as a light-on-
dark rgba inside the dark theme. No per-chart override required.

---

## 8. Axis label rules

Three labels max on the x-axis: "Nd ago" / "halfway" / "today". The reader
should be able to read the chart's time span in 1 second. Don't label every
bar - the bar widths and the bignum already carry the granularity.

Y-axis: omit it entirely. The bignum + the visual amplitude of the bars
carry the magnitude. A scale line down the left edge competes with the dot
grid and adds no information the reader couldn't infer from the headline.

For non-time-series (e.g. bar chart of strategies sorted by APY), use
strategy names or chain icons under the bars instead of generic axis labels.
The ecosystem chart on product pages does this - see the `eco-chart-axis`
pattern in the live codebase for a worked example.

---

## 9. Annotations (vertical reference lines)

Use case: marking a milestone date on the chart (e.g. "Base Incentives
Start", "Audit completed", "Vault migration"). Render a single absolutely-
positioned vertical line over the plot, with an inline label.

```html
<div class="chart-bars">
  <!-- bars... -->
  <div
    class="chart-marker"
    style="left: 73%"
    data-marker-label="Base Incentives Start - May 10, 2026"
  ></div>
</div>
```

```css
.chart-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: oklch(0.62 0.16 245);   /* canonical second-series blue */
  pointer-events: none;
}
.chart-marker::after {
  content: attr(data-marker-label);
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: oklch(0.62 0.16 245);
  color: #ffffff;
  font-family: var(--sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 4px 8px;
  border-radius: 6px;
  white-space: nowrap;
}
```

Pin the `left: NN%` to where the milestone date sits on the time axis (you
compute this at render time from `(milestoneDate - chartStart) / chartSpan`).
Blue is reserved for these annotations exactly because it isn't the brand
colour - the reader's eye distinguishes data (gold) from milestones (blue)
at a glance. Use the same blue for the secondary-series line in multi-metric
overlays (Section 4) so the two roles share a hue family.

Don't use red for annotations. Red is reserved for outlier / error states
(corrupted data points). A blue milestone line on a gold-bar chart with a
red outlier bar is the clearest visual hierarchy the palette gives us.

---

## 10. What NOT to do

- **Don't use a charting library** (recharts, chart.js, victory). They each
  add 60-200KB of JS to a bundle that currently ships 0 KB for chart code,
  and they all push their own visual defaults that fight the brand.
- **Don't add gridlines**. The dot grid already gives the eye scale. Adding
  horizontal lines turns the plot into Excel.
- **Don't colour bars by category** (one colour per strategy / asset / etc).
  Gold-only is the discipline. If you need to distinguish series, use the
  multi-metric overlay pattern (Section 4) with the canonical blue.
- **Don't autoplay any chart animation**. Charts feel alive when the cursor
  hovers them - never on page load. We don't draw lines or grow bars on
  mount.
- **Don't add a legend**. If a chart needs a legend, the bignum + label
  pattern (Section 2) isn't doing its job - rewrite the bignum to carry
  what the legend would have said.
- **Don't tilt axis labels**. Three labels max, all upright. If you need
  more granularity, you're using the chart wrong - swap to a sparkline
  inside a table row.
