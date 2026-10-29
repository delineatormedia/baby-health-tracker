# Design direction: Instrument

The owner picked direction C (Darkroom) in #2 and asked for three changes: a
calmer night mode, less on each screen, and a diaper flow split into steps.
This folder holds the merged direction. It is the reference for the #6 UI.

- `direction.html`: static mockups of every v1 screen, light and night. Open
  `direction.html?board=core` or `?board=rest` in a browser.
- `board-core.png`, `board-rest.png`: renders of the two boards.
- `board-home.png`, `board-home-deut.png`: the glanceable Home (#20), and the
  same board through a deuteranopia simulation (`?board=home&cvd=deut`).
- `explorations/`: the three original directions (A Ledger, B Nest, C Darkroom),
  kept for the record.

These are mockups, not app code. All names and numbers are fake.

## Principles

- **Instrument, not a diary.** Readings are drawn as ranges on a scale with a
  pointer. Labels are monospaced caps, and numbers use tabular figures.
  Keep it subtle: no bevels, no fake chrome.
- **One job per screen.** If a screen needs a second idea, it gets a second
  screen or an optional step.
- **Thumb zone.** Primary actions sit at the bottom. Targets are at least 52 px
  tall, and the main action is 66 px.
- **Undo, never confirm.** Every log shows a toast or a row with Undo.
- **Readable at arm's length.** A tired parent holding a baby has to read it at
  a glance (owner, #20). See Type sizes.

## Type sizes

This applies to every screen, not only Home (#20).

| Text | Minimum |
|---|---|
| Button labels (quick-log keys, primary and secondary actions, segmented controls, options) | 20 px |
| Body text, list rows, toasts, readings values | 17 px |
| Secondary text (captions, monospaced labels, "last logged" lines, hints) | 15 px |

- Nothing a parent has to read is smaller than 15 px. Phone OS chrome (the
  status bar) is not ours.
- Any text a parent has to read meets WCAG AA (4.5:1) on the surface it sits on.
  That is why `dim` changed in #20: the old values were 3.84:1 (light) and
  3.03:1 (night) on the panel.
- Long lines may wrap, but a line must never truncate a number or a side.

## Tokens

| Token | Light | Night |
|---|---|---|
| bg | `#ECEFF1` | `#0D0C0B` |
| panel | `#FFFFFF` | `#161513` |
| ink | `#1F2A33` | `#ADA59A` |
| dim | `#5B6670` | `#8A8378` |
| line | `#D9DEE2` | `#252320` |
| accent | `#2E6A8E` | `#6F8F84` |
| band (expected range) | `#D6E4EC` | `#1E2925` |
| flag | `#A8552F` | `#C29A62` |

Night is "graphite": warm near-black, dim stone text and a muted sage accent.
There is no red or amber tint, because red reads as an emergency in a medical
app. Night text is a dim stone, never white, so the screen stays dim. The
flag color is the only warm accent, and it appears only on a flag.

### Event colours (#20)

Each event type has its own colour and its own shape. The shape is the same on
the dial, in the legend, on the quick-log key and in History, so the types stay
apart without colour.

| Event | Shape | Light | Night |
|---|---|---|---|
| Feed (breastfeed) | bar on the outer ring | `#6E2A9C` | `#B880D8` |
| Bottle | hollow ring on the outer ring | `#08664C` | `#25876B` |
| Wet | dot on the inner ring | `#1F6FD6` | `#4C8EF0` |
| Dirty | square on the inner ring | `#7F7410` | `#ABA53A` |
| Pump | diamond (keys and History; not on the dial) | `#C2367A` | `#DA7AA0` |

- **Strokes, marks and outlines only.** Event colours are never used for text
  and never fill a large area. The one exception is a running timer key, which
  takes a 16% tint of its colour behind ink text.
- **Night stays dim.** Every night event colour has a relative luminance at or
  below 0.36, under the night ink (0.381). Nothing on Home is brighter than the
  text already on it, and none of the colours is red.
- **Contrast, computed by hand** (WCAG 2.x relative luminance; Lighthouse skips
  gradients). Graphics need 3:1 (WCAG 1.4.11), and every pair passes on both
  backgrounds:

| Event | Light on bg | Light on panel | Night on bg | Night on panel |
|---|---|---|---|---|
| Feed | 7.35 | 8.49 | 6.62 | 6.18 |
| Bottle | 6.03 | 6.96 | 4.43 | 4.13 |
| Wet | 4.23 | 4.88 | 5.99 | 5.59 |
| Dirty | 4.13 | 4.76 | 7.61 | 7.10 |
| Pump | 4.43 | 5.12 | 6.77 | 6.32 |

  Text: ink on panel is 14.61 (light) and 7.50 (night). The new `dim` is 5.87
  and 4.86 on the panel, and 5.08 and 5.21 on the background. On the tinted
  running key, text is ink: 11.15 (light) and 5.95 (night).
- **Colour vision.** The palette was checked under a deuteranopia simulation
  (Machado et al. 2009, severity 1). The closest pair is 0.089 apart in OKLab
  (night feed and wet), against 0.047 for an Okabe-Ito-style set. Feed and wet
  both look blue to a deuteranope, so they differ in lightness and shape (bar on
  the outer ring, dot on the inner ring). Bottle and pump both look grey, but
  pump is not on the dial and every key is labelled.
- **Dirty and the flag.** The night dirty mustard and the night flag tan are
  close in hue. The flag never appears on Home, and a flag always carries "!"
  and its text, so colour alone never signals a flag.

**Stool swatches are true-color in every mode.** They sit in their own well and
never take the theme tint. The red-flag colors (pale yellow, clay, white, red)
are grouped under "Consider talking to your pediatrician".

## Home quick-log keys (#20)

- **Layout.** Feed is the tall key on the left. Wet, Dirty, Bottle and Pump
  share the other two columns. Weight, History and Readings move to the row
  above. Wet is still one tap.
- **Outline.** Each key has a 2 px outline in its event colour, in both themes.
  A running feed key has a 3 px outline, the 16% tint, the live timer and the
  side.
- **Last logged.** Line one is the time since the last event of that type,
  compact: "Just now" under 1 minute, then "54m ago", then "3h 10m ago". Over
  24 h it is the date ("Oct 27"). Line two is the clock time ("at 11:49 PM"),
  except:
  - Feed has three lines: the time since, the clock time, and the last side
    ("Left side"). The side is the side of the last breastfeed.
  - Bottle shows the last amount ("60 mL").
  - Pump shows the last side ("Left side", "Right side" or "Both sides").
  - Nothing logged yet: "Not logged yet".
- **Freshness.** The lines come from the event store, not a cache. They change
  right after a log and right after Undo (the undone event no longer counts),
  and the elapsed time ticks at least once a minute.

## Flows

| Log | Taps from home |
|---|---|
| Wet diaper | 1 (Wet key) |
| Dirty diaper | 2 (Dirty, then a color). Details are an optional second step. |
| Mixed diaper | 3 (Dirty, "Also wet", color) |
| Bottle | 2 (Bottle, Log). The level starts at the last amount. |
| Breastfeed | 1 to start, 1 to stop |

## Screens

Core: home (24-hour dial), breastfeed timer, diaper color, diaper details,
bottle, readings (flag and all-clear states), why.

Remaining: pump, weight, history, add a baby, household settings, sign in.

## Readings and flag copy

- The milk-supply estimate and any intake uncertainty display are out of v1
  (owner, 2026-10-29; #11). Readings shows recorded volume as approximate
  ("≈410 mL"), with no range.
- The intake row is headed "Recorded bottle intake", not "Total intake".
  When any feed is unmeasured (a breastfeed) or the other phone's sync is
  stale, it reads "Not enough information to assess total intake".
- Missing logs are not evidence (docs/CLINICAL_REFERENCE.md). Count checks
  (wet and dirty diapers) run only on periods the parents marked as fully
  logged, with both phones synced. Otherwise they read "Not enough data".
- A reassuring line names only the checks that were evaluated ("Diapers and
  weight are in the expected range"). Never a blanket "everything is fine".
- Flags default to "Consider talking to your pediatrician". Stronger urgency
  appears only where docs/CLINICAL_REFERENCE.md cites it, and the Why screen
  shows that citation. Example: a pale or clay stool reads "Call your
  pediatrician promptly" (AAP: "as soon as possible"; NHS: urgent).
- Copy never diagnoses and never promises an outcome.
