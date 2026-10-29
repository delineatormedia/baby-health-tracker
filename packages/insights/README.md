# @bht/insights

`evaluate()` turns a baby's event log into Readings. Every threshold comes from
`data/thresholds.json`, the merged #11 reference documented in
[docs/CLINICAL_REFERENCE.md](../../docs/CLINICAL_REFERENCE.md). The evaluator has no I/O and
no clock: the same input gives the same results.

## App policy

These rules are decisions about the app, not statements from #11. Each one is also named in the
code next to the rule it changes, and in the Why text where a reading shows it. All of them
were decided by PM on #7 and #16 (2026-10-29).

- **Red-flag lookback: 7 days** (`RED_FLAG_LOOKBACK_DAYS`). A pale, black or bloody stool
  stays visible for 7 days. v1 has no "talked to the pediatrician" acknowledgement.
- **Birth weight** is the first weight event, and only if it was logged in the first 24 h.
- **The 8 h composite dehydration rule** (`no_urine_hours_dehydration`) needs signs v1 does
  not log, so it is cited and never flags.
- **Feeding population.** Entries whose population is breastfed apply only when every feed in
  the window is breast milk (at the breast or a breast-milk bottle), and the window is fully
  logged and synced. Any formula, or no feed at all, gives `not_enough_data` with reason
  `feeding_not_exclusive` when no other entry can decide. The window is the day for daily
  counts and the 24 h before the evidence time otherwise (the pull for no urine, the weigh-in
  for ABM weight loss, the stool for ABM meconium). Formula-fed entries apply when formula was
  logged. The WHO growth standards apply to every infant whatever the feeding.
- **Feed episodes** (`FEED_EPISODE_GAP_MINUTES`). A feed record that starts within 30 minutes
  of the end of the previous one is the same feed, so a breastfeed and its top-up count once.
  A weighted feed is a measurement, never a feed. An episode belongs to the day its first
  record starts in.
- **The day-21 stool exception.** Low stool counts stop applying from day 21 only if
  `weight_gain` is `ok` and no stool in the lookback was logged as hard. Otherwise the low-count
  check runs as usual.
- **Day 2 stools.** CDC's "fewer than 3" decides over the AAP's 1–2 normal range. The Why text
  states the AAP range.
- **"None logged".** An `ok` from `pale_stool`, `black_stool` or `blood_in_stool`
  (`NONE_LOGGED_CHECKS`) means no such stool was logged, not that there was none. Show it as
  "None logged". `inExpectedRange()` leaves these checks out of the "in the expected range"
  line.
- **Strict bounds (#26).** `observed.expected.minStrict` / `maxStrict` are true when an `lte` /
  `gte` entry sits on the bound, so the bound value itself flags. Word it "above" / "below";
  otherwise "at least" / "at most". A `gte 8` rule with 9 observed reads "expected below 8".

## Inputs

- `fullyLogged`: the periods the parents marked as fully logged. Count and absence checks run
  only inside them. The mark is the only thing that vouches for writes still offline on the
  other phone. The web app passes birth to now minus the days marked "We missed some" (#24,
  owner decision B: fully logged by default).
- `syncedThrough`: this device has no pending writes and last pulled at this time, or null. It
  says nothing about the other phone. Absence checks are judged at this time, never later.
