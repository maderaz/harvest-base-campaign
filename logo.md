# Harvest logo and animation

Wordmark plus a single Sunflower Gold square dot, sitting on a baseline-aligned
flex row. On hover the dot hops upward and flips colour from gold to onyx. The
wordmark is plain text in the display font, the dot is a 5x5 div, the animation
is one CSS transition - no SVG, no images, no JS.

If you are an AI rebuilding the brand in a new project: copy the four chunks
below verbatim into your code (HTML / CSS / font import) and you'll have the
exact mark used on harvest.finance.

---

## 1. The mark

Two stacked tokens:

- The wordmark: the literal word `Harvest` set in Inter Tight (the `--display`
  family), weight 600, font-size 15px, letter-spacing -0.02em. Lowercase
  letters are intentional only on the `H`; everything else picks up the
  natural case from the word.
- The dot (the "pip"): a 5 by 5 pixel block with a 1px border-radius (so it
  reads as a soft square, not a circle), filled Sunflower Gold `#ffb936`,
  sitting on the same baseline as the wordmark's ascender line.

That's it. No icon, no monogram, no mascot.

---

## 2. Markup

```html
<a href="/" class="brand" aria-label="Harvest, go to homepage">
  <span class="brand-name">Harvest</span>
  <span class="brand-dot" aria-hidden="true"></span>
</a>
```

- Wrap in an `<a>` so the entire mark is one click target.
- `aria-label` on the anchor; `aria-hidden` on the decorative dot.
- Order matters: wordmark first, dot second. The dot reads as a tonal pip
  *after* the word, not before it.

---

## 3. Styling

```css
.brand {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  transition: background 0.12s;
  text-decoration: none;
  color: inherit;
}
.brand:hover  { background: var(--bg-2, #f4f4f2); }
.brand:active { background: var(--line, #ebebe7); }

.brand-name {
  font-family: var(--display, "Inter Tight", system-ui, sans-serif);
  font-weight: 600;
  letter-spacing: -0.02em;
  font-size: 15px;
  color: var(--ink, #191717);
}

.brand-dot {
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: #ffb936;            /* Sunflower Gold - the brand anchor */
  display: inline-block;
  position: relative;
  top: 0;
  transition:
    transform 0.5s cubic-bezier(0.5, 1.75, 0.5, 1),
    background 0.18s ease;
}
```

`align-items: baseline` is load-bearing - it puts the dot on the wordmark's
text baseline (not its top edge), which is how it reads as a "period after
the word". `gap: 4px` is the exact spacing between the `t` of "Harvest" and
the dot; tighter and the dot reads as a connected mark, wider and it reads
as a separate object.

---

## 4. The hover animation

One transition on `transform` plus one on `background`. The dot lifts 7px
upward and flips from gold to onyx, then springs back when the cursor leaves.
The cubic-bezier overshoots at the apex so the lift feels alive rather than
mechanical.

```css
.brand:hover .brand-dot {
  transform: translateY(-7px);
  background: var(--ink, #191717);
}
```

The numbers, in order of importance:

| Number | What it does | Don't change |
| --- | --- | --- |
| `transform: translateY(-7px)` | Pip height. Reads as a little hop. | Larger gets cartoonish; smaller doesn't register. |
| `0.5s` transition duration | The whole jump-and-settle motion. | Faster = nervous; slower = sluggish. |
| `cubic-bezier(0.5, 1.75, 0.5, 1)` | Springy overshoot at the top. | The `1.75` is the spring coefficient. Anything above 2 wobbles too much. |
| `0.18s ease` colour transition | Slower than the position so the colour change "lands" after the lift completes. | Synchronising them kills the personality. |

The animation runs purely on hover - no autoplay, no on-load, no scroll
trigger. Brand marks should feel alive only when interacted with.

---

## 5. Reduced motion

Honour `prefers-reduced-motion`. Drop the transform but keep the colour
flip so the hover state stays legible.

```css
@media (prefers-reduced-motion: reduce) {
  .brand-dot { transition: background 0.18s ease; }
  .brand:hover .brand-dot { transform: none; }
}
```

---

## 6. Where it's used in the live site

- Top navigation, left edge: every page.
- Footer brand block: same markup, same classes, sits in a column header.
- Admin sidebar: same markup, with a small `Admin` tag chip to the right.

It does not appear inside hero sections, page bodies, or marketing cards -
the wordmark is reserved for chrome (top/bottom of every page, plus admin
shell). Putting it in editorial content would dilute the recognition.

---

## 7. Variants you should NOT make

- A circular dot. Use the 1px border-radius soft square. The blockiness
  matters; it reads as a financial / data mark, not as a logo for a kids'
  app.
- A larger dot (>7px). Once the dot is bigger than the wordmark's x-height
  it stops reading as a pip and starts looking like a separate emblem.
- A dot in a non-gold colour. Sunflower Gold (`#ffb936`) is the one
  accent in the whole product palette. The dot is the brand's anchor in
  the chrome; swapping it for blue / green / red breaks the rest of the
  system because every other gold element references the same hex.
- An animation that runs on page load. Brand marks announce themselves
  through layout, not motion. The hop is feedback for interaction; making
  it ambient turns it into noise.
- Removing the dot entirely. Without it the wordmark reads as just a word.
  The dot is the recognisable shape of the mark.

---

## 8. Quick sanity check

After integrating, hover the wordmark in your dev tools. You should see:

1. The dot lifts 7px upward.
2. The dot recolors from gold to onyx during the lift.
3. The pad behind the wordmark warms to a near-white grey.
4. Cursor out: the dot springs back down (slightly overshooting before
   settling) and recolors to gold.
5. The cursor change to pointer happens immediately, not after a delay.

If any of those five don't happen, recheck the transition / hover selectors.
