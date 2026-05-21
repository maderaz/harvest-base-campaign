# Harvest design system bundle

Five files, self-contained. Drop into any project and recreate the visual
language used by harvest.finance.

## Files

| File | What's in it |
| --- | --- |
| `design-system.md` | Master document. Palette, typography, spacing, naming conventions, component patterns, integration recipe. **Read this first.** |
| `tokens.css` | CSS variables for the light theme + the dark-mode override block. The only file containing raw hex values; everything else reads from `var(--...)`. |
| `components.css` | Reusable component classes: hero, stat tile, hub-table, pills, CTAs, cards, notes, helpers. |
| `darkmode.css` | Dark-theme scope overrides + pill contrast lifts + CTA shadow alpha bumps. Activated by `<html data-theme="dark">`. |
| `README.md` | This file. |

## 60-second integration

1. Copy all four CSS / MD files into your project (e.g. `src/styles/`).
2. Import them in this order:
   ```css
   @import "./tokens.css";
   @import "./components.css";
   @import "./darkmode.css";
   ```
3. Load Inter, Inter Tight, JetBrains Mono. With `next/font`:
   ```ts
   import { Inter, Inter_Tight, JetBrains_Mono } from "next/font/google";
   const inter = Inter({ subsets: ["latin"], weight: ["400","500","600"], variable: "--font-inter", display: "swap" });
   const interTight = Inter_Tight({ subsets: ["latin"], weight: ["500","600","700"], variable: "--font-inter-tight", display: "swap" });
   const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400","500"], variable: "--font-jetbrains-mono", display: "swap" });
   // <html className={`${inter.variable} ${interTight.variable} ${jetbrainsMono.variable}`}>
   ```
4. Inline the theme-resolver script in `<head>` before any stylesheet links
   so dark-mode users never see a light-mode flash:
   ```html
   <script>
     (function(){try{var s=localStorage.getItem('theme');var t=s==='dark'||s==='light'?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
   </script>
   ```
5. Wrap your page content in `<div class="uni-hub-test">` (for hub / list /
   admin pages). Use the component classes documented in
   `design-system.md` Section 6.

## Verification checklist

After integration, toggle `data-theme="dark"` on `<html>` via devtools. The
whole page should flip cleanly to dark with no element stuck on a light-mode
hex. If something stays light, you have a hardcoded colour somewhere that
needs to migrate into the token system.

Then in light mode, audit `.dim` / `.dim-small` body text for WCAG AA
contrast (4.5:1 floor for normal text, 3:1 for >=18px). `.dim` uses
`--ink-2` which clears AA on both themes; `.dim-small` uses `--ink-3` and is
only for <=12px chip-sized labels per WCAG 1.4.3.

## Caveat

This bundle is a portable starting point, not the full Harvest stylesheet.
The live site has hundreds of additional rules for chart-specific
visualisations, navigation chrome, sticky headers, the cookie banner, and
admin-only surfaces. What's here is the *foundation* - palette, type, spacing,
and the half-dozen patterns that show up everywhere. Build on top.
