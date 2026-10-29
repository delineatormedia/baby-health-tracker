# Brand sources: icon shortlist (concept round)

SVG sources and PNG exports for the three shortlisted icon concepts in the
Instrument direction (#14). The **name is not chosen yet** — the naming call
belongs to the owner. Concept board reviewed 2026-10-29 ("accept with nits");
that review validated the rendered board, this PR is the source of truth it
was reviewed against, plus the exports and manifest fixes noted below.

## Contents

- `svg/` — 1024 master sources, night + light per concept. Every hex in a
  file is listed with its canonical #14 token name in an SVG comment.
- `png/` — rendered exports at 512, 192 (PWA "any" + "maskable") and 48
  (legibility proof on both backgrounds).
- `generate.mjs` — regenerates everything (`npm i @resvg/resvg-js`).

Geometry is frozen as reviewed; changes to the marks need a fresh review.

## Token mapping

The board post used nicknames ("stone", "steel"); the canonical #14 token
names are authoritative and are the ones used in the SVG comments:

| Hex | Token (#14) | Board nickname | Used for |
|---|---|---|---|
| `#0D0C0B` | night `bg` | graphite | all night tiles, manifest theme/bg |
| `#ADA59A` | night `ink` | stone | Cairn stones, Fledge stroke, Hearth arch |
| `#6F8F84` | night `accent` | sage | top stone, head/wing/beak, flame |
| `#68625A` | night `dim` | — | Fledge baseline ticks |
| `#ECEFF1` | light `bg` | — | all light tiles |
| `#1F2A33` | light `ink` | — | dark marks on light tiles |
| `#77848E` | light `dim` | — | Fledge ticks |
| `#2E6A8E` | light `accent` | steel | accents on light tiles |

No red, no `flag` token: the flag colors are UI-only and never appear in
brand marks. No bevels, no fake chrome.

## Safe zone and legibility (reviewed 2026-10-29)

- All six tiles keep the mark inside the Ø80% maskable safe zone (limit
  r 409.6 at 1024, i.e. ratio 0.800). Metric: **max distance from canvas
  center over rendered mark pixels ÷ 512**, measured on the 1024 masters
  rendered at 2× (2048 px), threshold-summed channel diff > 90 against the
  tile bg. Measured on the masters: **Cairn 0.744, Hearth 0.741, Fledge
  0.769** — identical night and light. (The board review quoted
  0.760/0.765/0.757/0.779; those were pixel measurements of the rendered
  208 px board tiles and are superseded by these master measurements.)
- At 48 px: Cairn reads clearly (three stones, accent top) — the strongest of
  the three; Hearth reads (arch + droplet).
- Fledge does not read below ~96 px ("rising trend + reading point"). If
  Fledge is chosen it needs a dedicated small-size optical variant (thicker
  taper, larger head, baseline ticks dropped) before it ships.

## Naming status (2026-10-29)

- Recommendation: **Cairn**. Note for the owner's decision: a live App Store
  (iTunes US) search found two existing Health & Fitness apps named Cairn,
  including "Cairn – Hiking Safety Tracker" (same category, tracking
  semantics). The still-owed domain + trademark sweep should prioritize it.
- Wording correction from review: Cairn's stones are **size**-graded
  (slab / capsule / pebble) and tonally flat — the perceived tonal step is
  simultaneous contrast from the sage top stone, not a second color.

## Manifest wiring (once an icon is chosen)

`manifest.webmanifest` keeps the placeholder icon until the owner picks a
name; that swap should land as its own reviewed PR. Then:

1. Copy the chosen concept's night exports to `apps/web/static/` as
   `icon-512.png` / `icon-192.png` ("any"), plus
   `icon-maskable-512.png` / `icon-maskable-192.png`.
2. Keep `theme_color` / `background_color` at `#0D0C0B` and declare the
   maskable pair with `"purpose": "maskable"` (the "any" pair with
   `"purpose": "any"`).
3. Wordmark and app-store variant pass follow the name choice.

## Fixed in this PR

- `manifest.webmanifest` theme/background `#1c1b19` → `#0D0C0B` (the #14
  night bg) and explicit `"purpose": "any"` / `"maskable"` entries. The
  placeholder PNGs are geometrically maskable-safe (full-bleed bg, mark
  Ø27% of canvas), so the maskable claim is honest until the real icon.
- Placeholder `icon.svg` recolored to the same night tokens so the install
  tile matches the theme color instead of flashing a near-black mismatch.
