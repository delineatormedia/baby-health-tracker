# Design direction: Instrument

The owner picked direction C (Darkroom) in #2 and asked for three changes: a
calmer night mode, less on each screen, and a diaper flow split into steps.
This folder holds the merged direction. It is the reference for the #6 UI.

- `direction.html`: static mockups of every v1 screen, light and night. Open
  `direction.html?board=core` or `?board=rest` in a browser.
- `board-core.png`, `board-rest.png`: renders of the two boards.
- `explorations/`: the three original directions (A Ledger, B Nest, C Darkroom),
  kept for the record.

These are mockups, not app code. All names and numbers are fake.

## Principles

- **Instrument, not a diary.** Readings are drawn as ranges on a scale with a
  pointer. Labels are small monospaced caps, and numbers use tabular figures.
  Keep it subtle: no bevels, no fake chrome.
- **One job per screen.** If a screen needs a second idea, it gets a second
  screen or an optional step.
- **Thumb zone.** Primary actions sit at the bottom. Targets are at least 52 px
  tall, and the main action is 66 px.
- **Undo, never confirm.** Every log shows a toast or a row with Undo.

## Tokens

| Token | Light | Night |
|---|---|---|
| bg | `#ECEFF1` | `#0D0C0B` |
| panel | `#FFFFFF` | `#161513` |
| ink | `#1F2A33` | `#ADA59A` |
| dim | `#77848E` | `#68625A` |
| line | `#D9DEE2` | `#252320` |
| accent | `#2E6A8E` | `#6F8F84` |
| band (expected range) | `#D6E4EC` | `#1E2925` |
| flag | `#A8552F` | `#C29A62` |

Night is "graphite": warm near-black, dim stone text and a muted sage accent.
There is no red or amber tint, because red reads as an emergency in a medical
app. Night text is a dim stone, never white, so the screen stays dim. The
flag color is the only warm accent, and it appears only on a flag.

**Stool swatches are true-color in every mode.** They sit in their own well and
never take the theme tint. The red-flag colors (pale yellow, clay, white, red)
are grouped under "Consider talking to your pediatrician".

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
- When any feed is unmeasured (a breastfeed) or the other phone's sync is
  stale, intake reads "Not enough information to assess total intake".
- A reassuring line names only the checks that were evaluated ("Diapers and
  weight are in the expected range"). Never a blanket "everything is fine".
- Flags default to "Consider talking to your pediatrician". Stronger urgency
  appears only where docs/CLINICAL_REFERENCE.md cites it, and the Why screen
  shows that citation. Example: a pale or clay stool reads "Call your
  pediatrician promptly" (AAP: "as soon as possible"; NHS: urgent).
- Copy never diagnoses and never promises an outcome.
