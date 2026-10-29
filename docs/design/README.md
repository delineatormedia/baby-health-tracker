# Design direction: Instrument

The owner picked direction C (Darkroom) in #2 and asked for three changes: a
calmer night mode, less on each screen, and a diaper flow split into steps.
This folder holds the merged direction. It is the reference for the #6 UI.

- `direction.html`: static mockups of every v1 screen, light and night. Open
  `direction.html?board=core` or `?board=rest` in a browser.
- `board-core.png`, `board-rest.png`: renders of the two boards.
- `board-home.png`, `board-home-deut.png`: the glanceable Home (#20), and the
  same board through a deuteranopia simulation (`?board=home&cvd=deut`).
- `board-reports.png`: Reports (#21), from `?board=reports`. The boundary
  cases are `board-reports-dst25.png`, `board-reports-dst23.png` and
  `board-reports-start.png`, from `?board=reports&case=dst25|dst23|start`.
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
| Anything tappable: quick-log keys, primary and secondary actions, segmented controls, options, stool swatches, Undo, the Home chips (Weight, History, Readings), Why?, header actions (the time edit, back), list rows that open something, form fields | 20 px |
| Body text that is not a control: titles, toast messages, readings values | 17 px |
| Non-interactive captions: monospaced labels, "last logged" lines, a row's second line, hints | 15 px |

- If you can tap it, its label is 20 px. Only text that does nothing when
  tapped may be smaller. A caption inside a tappable row (the "Clinic ·
  3 610 g" line under "Weight") is a caption.
- Nothing a parent has to read is smaller than 15 px. Phone OS chrome (the
  status bar) is not ours.
- All text meets WCAG AA (4.5:1) in both themes, measured after any opacity
  is blended in. There are no exceptions, so text never uses opacity. De-emphasis
  comes from the `dim` token, a lighter weight or a smaller size (see Text
  contrast). That is also why `dim` changed in #20: the old values were 3.84:1
  (light) and 3.03:1 (night) on the panel.
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
| flag | `#A0502B` | `#C29A62` |

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

  Text contrast has its own table below.
- **Text contrast** (measured, both themes). Every text node in
  `direction.html` was measured in Chrome after blending opacity and stacked
  backgrounds. The lowest is 4.75 (light) and 4.63 (night).

| Text | On | Light | Night |
|---|---|---|---|
| ink | panel | 14.61 | 7.50 |
| ink | bg | 12.65 | 8.03 |
| dim | panel | 5.87 | 4.86 |
| dim | bg | 5.08 | 5.21 |
| dim | diaper well | 5.87 | 4.63 |
| ink | running key (16% tint) | 11.15 | 5.95 |
| accent (header actions) | bg | 5.10 | 5.53 |
| button text (accInk) | accent | 5.89 | 5.53 |
| flag | flag panel | 4.88 | 6.87 |
| flag | bg (Why screen) | 4.95 | 7.53 |
| Weight last digit (dim, weight 200) | bg | 5.08 | 5.21 |

  Light `flag` moved from `#A8552F` to `#A0502B`: the old value was 4.48 on
  the flag panel. The Weight screen used to fade the last digit to 35% ink
  (2.03 light, 1.94 night). It is now `dim` at a lighter weight.

- **Stool swatch labels** are solid black or white, whichever passes on that
  swatch, never an opacity. They are the same in both themes because the
  swatches are true colour.

| Swatch | Label | Ratio |
|---|---|---|
| Yellow `#E6C24A` | black | 12.18 |
| Mustard `#C9A227` | black | 8.68 |
| Green `#6F7F2E` | black | 4.75 |
| Brown `#7A5230` | white | 6.82 |
| Black `#2A2420` | white | 15.31 |
| Pale yellow `#EFE6B8` | black | 16.68 |
| Clay `#BDB3A1` | black | 10.13 |
| White `#F4F1EA` | black | 18.62 |
| Red `#9E2A22` | white | 7.48 |

  Green used 66% black (3.31). Ink (3.31) and white (4.42) also fail on it, so
  it takes pure black.

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

## Reports (#21)

Reports are for looking back. History is for editing. Reports are read-only:
nothing on them opens an editor, and a parent who wants to change an event uses
History.

- **Way in.** "Reports ›" in the History header, and a tap on the Home dial
  (the dial is already the last 24 hours). The Home chips stay as they are,
  because a fourth chip at 20 px doesn't fit. History keeps "Both parents"
  beside its title.
- **Day, Week, Month.** A segmented control, then a stepper: ‹, the period
  ("Monday, Oct 26", "Oct 26 – Nov 1", "October 2026"), ›. Tapping the period
  opens a date picker. › is disabled on the current period.
- **Day.** Three summary cards: Diapers (wet and dirty), Feeds (breast and
  bottle) and Bottle (mL total and oz). If a weight was logged that day, a
  Weight card follows ("3.58 kg", then "7 lb 14 oz · Clinic"). Then a
  timeline from day start to day start, in the dial's shapes: feed bars (as long
  as the feed) and bottle rings on the top lane, wet dots and dirty squares on
  the next, pump diamonds on the last. A dotted line marks midnight. Then the
  list, oldest first, with an "After midnight · Tue Oct 27" divider. List rows
  are 17 px because they are not tappable. The Day screen scrolls; the board
  shows it at the top and scrolled to the divider.
- **Weight** has no mark on the dial, so it stays off the timeline. It shows as
  the Day card and a list row, "Weight · 3.58 kg / 7 lb 14 oz", with where it
  was taken under it. Week and Month don't show weight.
- **Week.** One line of daily averages over the days that have finished, then
  a row for each day: the day (20 px, opens the Day view), its counts, and a
  mini timeline. Today says "so far"; later days say "Not yet" and don't open.
- **Month.** Daily averages, then a calendar. Each day shows feeds (bar) and
  diapers (dot and square) and opens the Day view. Days before birth and future
  days are blank. Today is outlined and counts only so far.
- **Counts match the timeline.** Every count is computed from the same events
  the timeline draws. In the mockup, Monday Oct 26 is the same day in the Day
  view, the first Week row and the Month cell: 8 diapers, 9 feeds, 180 mL.
- **Units** follow the mL/oz setting. "Both" shows mL first.

### Day starts at

- A Household setting: Midnight, 6 AM, 7 AM, 8 AM, 9 AM or Other (the
  phone's time wheel). The default is Midnight.
- It moves the day boundary in Reports and in History's day headings. With
  8 AM, a 3 AM feed belongs to the night before.
- It never changes Readings. Those count day-of-life windows from the birth
  time (#11), and the screen says so under the setting. The implementation
  needs #21's test that Readings are identical before and after a change.
- The Day view says what its window is: "8 AM to 8 AM Tue", or "Midnight to
  midnight". In `case=start`, the 3:00 AM Tuesday feed is in Monday with 8 AM
  and in Tuesday with Midnight, and the Week rows move with it.
- Until household sync (#5) lands, the setting is per phone (issue #21).

### Daylight saving

Days are cut at the day start in the household's time zone, not every 24
hours, so a day can be 23 or 25 hours. The mockup builds every event from a
real date in America/New_York.

- The Day subtitle adds the length: "8 AM to 8 AM Sun · 25 h". The Week row
  says "25 h" under the day, and its mini timeline spans that day's own hours.
- The timeline gives every real hour the same width, so a 25 h day draws 25
  hours and its axis ticks follow the clock.
- **Clocks back (25 h, `case=dst25`).** The repeated hour is shaded on the
  timeline, a note under it says what happened, and the list has a "Clocks went
  back · 1 AM again" divider. A time in the second hour reads "1:30 AM (2nd)".
- **Clocks forward (23 h, `case=dst23`).** A solid line marks the jump, the
  note says there was no 2 AM hour, and the list has a "Clocks went forward ·
  no 2 AM" divider. The axis tick that would be 2 AM reads 3 AM.

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

Reports: day (top and scrolled), week, month, Day starts at, and History's
"Reports ›" header. Cases: 25 h day, 23 h day, Day starts at 8 AM vs midnight.

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
