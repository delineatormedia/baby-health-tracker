# Clinical reference

The cited thresholds behind the insights engine. The machine-readable version is
[`packages/insights/data/thresholds.json`](../packages/insights/data/thresholds.json).
Every number there carries its source, confidence, population and age window.

Sources were fetched and checked in October 2026.

## Disclaimer

This app does not diagnose anything. These thresholds come from public guidance
for healthy, full-term babies. The app uses them to suggest that you **consider
talking to your pediatrician**. They do not replace a clinician's examination.
They do not apply as-is to babies born preterm, babies in or recently out of a
NICU, or babies with known medical conditions; follow your care team's plan for
those babies. If your baby seems unwell, is very sleepy or hard to wake, has a
fever in the first months, or you are worried, call your pediatrician or
emergency services regardless of what the app shows.

## Conventions

- **Age.** `age_range.from_days` is inclusive and `to_days` exclusive, both in
  completed days since birth. "Day of life 1" means age 0–1 days, so "day 5"
  means `from_days: 4`. Where a source gives exact hours (ABM's 120 h), the
  entry uses `from_hours`/`to_hours` instead and the day convention does not
  apply. An entry never uses both.
- **Where a window comes from.** `age_range.basis` is `source` when the source
  states the window and `app_choice` when this file chose it (for example, how
  long a rule stays active after the source's trigger age). Informational
  entries do not claim a validated clinical window.
- **Measurement interval vs. eligibility.** WHO weight-velocity entries carry an
  `interval` (the span the weight gain is measured over) separately from
  `age_range` (when the rule may be evaluated). The rule is evaluated only after
  the whole interval has been observed, so the 0–4 week increment is checked
  from day 28.
- **Units.** Volumes are in mL and weights in grams. For human milk, 1 g ≈
  0.97 mL (density about 1.03 g/mL, [Cheema 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8911220/)).
  Entries from studies that report grams keep the original figure in
  `source_value`/`source_unit` and record the division by 1.03 in `conversion`,
  marked approximate. Per-feed, per-day and population figures stay in
  separate metrics.
- **Directions and operators.** Every flagging entry states its comparison in
  `op` (`lt`, `lte`, `gt`, `gte`), copied from the source's wording: "fewer
  than", "1 or 2", "more than" and "8% or more" are not interchangeable.
  - `below_min_flag`: the observed value is compared with `value` using `op`.
  - `above_max_flag`: the same, for an upper bound or a count that should not
    be reached (for example, 2 or more downward centile crossings).
  - `red_flag_any`: flag when the count of occurrences meets `value` (one
    occurrence unless the source says more).
  - `expected_range`: the normal span; use it to give context or to suppress
    flags.
  - `informational`: never flags on its own.
- **Optional fields.**
  - `sex` (`male`/`female`) appears only on WHO growth-velocity entries.
  - `condition` appears on the NICE centile entries, which depend on birth-weight
    centile.
  - `requires_signs` lists signs the source pairs with the threshold. The app
    logs none of them, so the entry is cited but never flags on its own
    (`no_urine_hours_dehydration`).
- **Deferred entries.** `status: deferred` means the entry is recorded but must
  not run until its missing inputs exist (see NEWT in section 3).
- **Overlapping entries.** Where sources disagree, both entries are kept. The
  engine should show the stricter flag and cite both sources under "why?".
  Two exceptions take precedence over that policy:
  - **Source exceptions win.** If a source exempts a case, its entry does not
    apply to that case, and no other entry may flag it in that source's name.
    `suppressed_by` lists the entries that switch a flag off and when.
  - **Low-confidence entries never win.** Entries marked informational, such as
    the legacy 7% weight-loss rule, are never selected as the stricter flag.
- **Missing logs are not evidence.** A gap in the log means nothing was logged,
  not that the baby did not feed or urinate. Count-based rules must only run
  on periods the parents marked as fully logged, and otherwise say "not enough
  data".

## 1. Wet diapers

| Day of life | Minimum wet diapers / 24 h | Source |
|---|---|---|
| 1 | 1 | CDC |
| 2 | 2 | CDC |
| 3 | 5 (soft flag) | CDC |
| 4 | 6 (soft flag) | CDC |
| 5–7 and after | 6 | CDC, AAP, NHS |

Sources for the table:

- The [CDC Newborn Breastfeeding Basics](https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/newborn-basics.html)
  table gives the counts above. It also says to call if a baby "has fewer than 3
  poops and fewer than 6 pees per day by 5 days old."
- The AAP gives the same 6+ target at slightly different ages:
  - [HealthyChildren](https://www.healthychildren.org/English/ages-stages/baby/breastfeeding/Pages/How-to-Tell-if-Baby-is-Getting-Enough-Milk.aspx):
    6 or more wet diapers with pale urine "by 5 to 7 days old".
  - [AAP First Office Visit](https://www.aap.org/en/patient-care/newborn-infant-and-early-childhood-nutrition/newborn-and-infant-health-assessment-and-promotion/first-office-visit-3-5-days/):
    6 or more clear urines "by day 4 or 5".
- The [NHS](https://www.nhs.uk/baby/breastfeeding-and-bottle-feeding/breastfeeding-problems/enough-milk/)
  says to expect only 2–3 wet nappies in the first 48 h, then at least 6 heavy
  wet nappies per day from day 5.

Urgent signs:

- **No urine for more than 8 hours on days 2–4.** The AAP symptom checker says
  to contact the doctor within 24 hours
  ([AAP KidsDoc](https://www.healthychildren.org/English/tips-tools/symptom-checker/Pages/symptomviewer.aspx?symptom=Breast-Feeding+Questions)).
- **No urine for more than 8 hours together with other signs of dehydration.**
  KidsDoc says to call or seek care now. The app does not log the other signs
  (dark urine, no stool for 24 hours, dry mouth, no tears), so an 8-hour gap
  alone never reaches "seek care now". The app checks the gap only on days 2–4,
  with the rule above.
- **Only 1–2 wet diapers in a day.** The AAP lists this as a sign of severe
  dehydration
  ([AAP](https://www.healthychildren.org/English/health-issues/injuries-emergencies/Pages/dehydration.aspx)).
  The entry uses `lte 2`, so exactly two flags. The source counts urinations;
  the app counts logged wet diapers, which can hold more than one.

Urine colour: dark urine or uric acid crystals ("brick dust", pinkish staining)
can be normal in the first days
([AAP](https://www.healthychildren.org/English/ages-stages/baby/Pages/babys-first-days-bowel-movements-and-urination.aspx)).
Persistent pink staining, or dark urine from day 5 when clear urine is expected,
is a reason to call. No source gives an exact day on which crystals become
abnormal, so the data file has no numeric entry for urate crystals.

## 2. Stools: count, colour and progression

**Expected progression.** These timings are for breastfed babies
([AAP KidsDoc](https://www.healthychildren.org/English/tips-tools/symptom-checker/Pages/symptomviewer.aspx?symptom=Breast-Feeding+Questions),
[AAP](https://www.healthychildren.org/English/ages-stages/baby/breastfeeding/Pages/How-to-Tell-if-Baby-is-Getting-Enough-Milk.aspx),
[CDC](https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/newborn-basics.html)):

- Days 1–2: meconium, which is black-green, thick and sticky, 1–2 a day.
- Days 3–4: transitional stools, greenish-brown, at least 2 a day.
- By days 4–5: yellow, loose and "seedy", at least 3 a day (AAP says at least
  3–4).

Formula-fed babies have tan-yellow, firmer stools, at least one a day (AAP).

**First meconium.** The first stool is usually passed within 48 h
([NHS](https://www.nhs.uk/baby/caring-for-a-newborn/how-to-change-your-babys-nappy/)).

**Still passing meconium on day 5.** Meconium stools on day 5 (120 h), or fewer
than 4 stools on day 4, are reasons to evaluate the baby
([ABM Protocol #3, 2017](https://www.bfmed.org/assets/DOCUMENTS/PROTOCOLS/3-supplementation-protocol-english.pdf)).
ABM gives exact hours, so the meconium entry starts at 120 h of age. It stays
active until 168 h, a cut-off this file chose.

**Fewer stools later is normal.** From about 3–6 weeks, some breastfed babies
pass soft stools only once every 4–7 days, and that can be normal
([AAP](https://www.healthychildren.org/English/ages-stages/baby/Pages/babys-first-days-bowel-movements-and-urination.aspx)).
Each source keeps its own ages:

- The AAP KidsDoc low-count flag (fewer than 3 a day) ends at 4 weeks, because
  KidsDoc exempts low stool frequency after that age.
- The NHS low-count flag runs to day 42 (this file's choice, matching NHS and
  CDC "after about 6 weeks").
- From day 21, both are switched off when stools are soft and weight gain is
  adequate (the breastfed-interval entry). A thriving five-week-old with soft,
  infrequent stools is not flagged.

### Red-flag colours

- **Pale, clay, chalky, grey or white stool.** Flag on any occurrence and
  prompt the parent to call the pediatrician promptly. AAP KidsDoc's own rule
  is narrower (call during office hours if it happens 2 or more times); the
  data file keeps that entry with its count of 2, and the single-occurrence
  entry controls what the app does.
  - The AAP says white poop needs to be brought to a doctor's attention "as soon
    as possible"
    ([AAP](https://www.healthychildren.org/English/ages-stages/baby/Pages/The-Many-Colors-of-Poop.aspx)).
  - This is the key sign of biliary atresia. Pale stools and dark urine
    typically appear by 4–6 weeks
    ([AAP](https://www.healthychildren.org/English/health-issues/conditions/abdominal/Pages/biliary-atresia.aspx),
    [NIDDK](https://www.niddk.nih.gov/health-information/liver-disease/biliary-atresia/symptoms-causes)).
  - The NHS says a pale creamy poo or dark pee in a baby older than 24 hours
    needs an urgent GP or 111 call, and to keep a sample
    ([NHS](https://www.nhs.uk/conditions/jaundice-in-babies/)).
- **The stool colour card.** Taiwan's universal stool colour card shows 7
  photos: 1–3 are abnormal (acholic) and 4–7 normal. The colour picker's
  red-flag swatches should match cards 1–3.
  - In screening programmes the card has a pooled sensitivity of about 80% and
    specificity of about 99.9%
    ([Gopal et al., PLOS ONE 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11357077/);
    [Chen et al., Pediatrics 2006](https://pubmed.ncbi.nlm.nih.gov/16585309/)).
  - A normal-looking stool therefore does not rule biliary atresia out.
  - Parents check stools in the first 1–2 months, because surgery before 60
    days gives better outcomes.
- **Black stool after meconium has passed.** Flag from day 5 onward. "By day 5,
  passing black or dark green stools is not normal"
  ([AAP KidsDoc](https://www.healthychildren.org/English/tips-tools/symptom-checker/Pages/symptomviewer.aspx?symptom=Breast-Feeding+Questions)).
  Blood turns black as it passes through the gut
  ([AAP](https://www.healthychildren.org/English/ages-stages/baby/Pages/The-Many-Colors-of-Poop.aspx)).
  Iron supplements can darken stool, but the app should still flag it.
- **Red stool or visible blood.** Flag on any occurrence and suggest telling the
  pediatrician.
  - Swallowed maternal blood, for example from a cracked nipple, is a common
    harmless cause.
  - Large amounts of blood, mucus or water mean call immediately
    ([AAP](https://www.healthychildren.org/English/ages-stages/baby/Pages/babys-first-days-bowel-movements-and-urination.aspx)).
- **Other unusual colours.** Any colour other than green that persists for more
  than 24 h without an explanation is a reason to call
  ([AAP KidsDoc](https://www.healthychildren.org/English/tips-tools/symptom-checker/Pages/symptomviewer.aspx?symptom=Stools+-+Unusual+Color)).

## 3. Newborn weight loss and regain

**Normal loss.** Breastfed babies lose 5.7–6.6% of birth weight on average (SD
about 2%), with the most loss on days 2–3
([Noel-Weiss 2008, systematic review](https://pmc.ncbi.nlm.nih.gov/articles/PMC3091615/)).
More than 20% of healthy breastfed babies lose more than 7%
([ABM #3](https://www.bfmed.org/assets/DOCUMENTS/PROTOCOLS/3-supplementation-protocol-english.pdf)).

**When to call.**

- **More than 10% of birth weight lost.** Get the baby assessed
  ([NICE NG75](https://www.nice.org.uk/guidance/ng75/chapter/Recommendations);
  [AAP](https://www.aap.org/en/patient-care/newborn-infant-and-early-childhood-nutrition/newborn-and-infant-health-assessment-and-promotion/first-office-visit-3-5-days/)).
- **8–10% or more lost on day 5 or later, or loss above the 75th percentile on
  the NEWT nomogram.** ABM calls for a careful assessment. It also says 10% is
  "an indicator for infant evaluation", not an automatic trigger for
  supplementation. The 8% entry is inclusive (exactly 8% flags) and starts at
  120 h, as ABM states.
- **More than 7% lost (older AAP figure).** Kept as informational only: the
  primary statement could not be verified and later work criticises it
  ([Mazzoni 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9021796/)). It is
  never chosen over the NICE, AAP and ABM rules.
- **Still losing weight after about day 5.** The AAP says babies "should start
  gaining weight steadily" from about 5 days
  ([AAP](https://www.healthychildren.org/English/ages-stages/baby/Pages/First-Month-Physical-Appearance-and-Growth.aspx)).

**NEWT nomograms.** These show how weight loss varies with delivery mode
([Flaherman et al., Pediatrics 2015](https://pubmed.ncbi.nlm.nih.gov/25554815/)):

- About 5% of vaginally delivered, exclusively breastfed babies have lost 10% or
  more by 48 h.
- More than 25% of babies delivered by caesarean have lost 10% or more by 72 h.

A single fixed cut-off therefore flags many healthy caesarean babies. The
curves cover only 6–72 h after vaginal delivery and 6–96 h after caesarean
delivery, in babies born at 36 weeks or later. The 75th-percentile entry is
deferred: it needs delivery mode, exact hours and the matching curve, none of
which are in this file, and it must never be extrapolated past the curves. The
study's population is not the same as the app's own eligibility rules.

**Regaining birth weight.**

- **Average.** ABM gives a mean of 8.3 days, with 97.5% regained by 21 days.
- **Population data.** In
  [Paul et al., Pediatrics 2016](https://pubmed.ncbi.nlm.nih.gov/27940721/)
  (singletons born at 36 weeks or later; the abstract does not limit the
  cohort to exclusive breastfeeding):
  - Half of babies were back to birth weight by day 9 (vaginal) or day 10
    (caesarean).
  - At 14 days, 14% of vaginal and 24% of caesarean babies were still below
    birth weight.
  - At 21 days, those figures were 5% and 8%.
- **AAP.** Birth weight is regained by 7–14 days. This is a soft flag at 14
  days.
- **NICE.** Consider referral if birth weight is not regained by 3 weeks. This
  is the firm flag at 21 days.

Both regain flags measure the baby's current age while birth weight has not yet
been regained (`gte` 14 and 21 days), so a baby still below birth weight at
exactly 21 days flags. Once birth weight is regained the flags clear. This is
separate from a completed time-to-regain, which is what the ABM mean
describes.

## 4. Weight gain and growth standards (0–24 months)

**Daily gain.** The average newborn gains almost 28 g a day in the first month
([AAP](https://www.healthychildren.org/English/ages-stages/baby/Pages/First-Month-Physical-Appearance-and-Growth.aspx)).

**WHO weight-velocity standards.** The WHO standards give the weight gained over
each 1-month interval
([boys](https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-velocity/lms_weight_boys_1mon_p.pdf?sfvrsn=e8ae6f73_7),
[girls](https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-velocity/lms_weight_girls_1mon_p.pdf?sfvrsn=e7614a98_11);
[index](https://www.who.int/tools/child-growth-standards/standards/weight-velocity)).
Values are the 5th percentile and median, in grams gained over the interval:

| Interval | Boys p5 | Boys median | Girls p5 | Girls median |
|---|---|---|---|---|
| 0–4 wk | 460 | 1023 | 446 | 879 |
| 4 wk–2 mo | 713 | 1196 | 578 | 1011 |
| 2–3 mo | 446 | 815 | 369 | 718 |
| 3–4 mo | 285 | 617 | 259 | 585 |
| 4–5 mo | 194 | 522 | 172 | 489 |
| 5–6 mo | 103 | 422 | 93 | 401 |

How to use these values:

- A gain below the 5th percentile is a soft "mention it at the next visit"
  flag. By definition, 5% of healthy babies fall below it. Using the 5th
  percentile as a flag is this app's policy; the WHO tables describe the
  distribution and do not prescribe an action.
- Each increment is evaluated once its whole interval has been observed (the
  0–4 week gain from day 28), using the weights nearest each end of the
  interval. Interval ends follow WHO's measurement schedule, not calendar
  months: days 0, 28, 61, 91, 122, 152 and 183, each with a ±3-day tolerance
  ([WHO Child Growth Standards: growth velocity, 2009, §2.4.2, Table 2](https://library.health.go.ug/sites/default/files/resources/WHO%20Child%20growth%20Standards%202009.pdf)).
  Returning "not enough data" when no weight falls inside the tolerance,
  instead of interpolating, is this app's policy.
- From about 7 months the 5th percentile is near or below zero. Percentile
  tracking replaces velocity flags from that age.

**Growth charts.** The CDC recommends the WHO standards for all children under
24 months. The cut-offs are ±2 SD, which are the 2.3rd and 97.7th percentiles,
often labelled 2nd and 98th
([CDC MMWR 2010](https://www.cdc.gov/mmwr/preview/mmwrhtml/rr5909a1.htm);
[CDC 2024](https://www.cdc.gov/growth-chart-training/hcp/using-growth-charts/who-using.html)).
The high cut-off screens weight-for-length, not weight-for-age. High
weight-for-age alone does not indicate excess weight, so that entry is
informational. A weight-for-length rule needs length measurements, which are
outside v1.

**Falling percentiles.** Two rules apply. Both count downward crossings and
flag when the count reaches the cited number (`gte`); zero crossings never
flags.

- **AAP.** Assess a baby whose weight gain drops across 2 major percentile lines
  ([AAP Undernutrition](https://www.aap.org/en/patient-care/newborn-infant-and-early-childhood-nutrition/undernutrition)).
- **NICE.** Concern depends on birth-weight centile
  ([NICE NG75](https://www.nice.org.uk/guidance/ng75/chapter/Recommendations)):
  - a fall across 1 or more centile spaces if birth weight was below the 9th
    centile;
  - 2 or more if it was between the 9th and 91st;
  - 3 or more if it was above the 91st;
  - or any weight below the 2nd centile, whatever the birth weight.

## 5. Milk intake

**Colostrum in the first days.** Average intake per feed rises quickly
([ABM #3, Table 2](https://www.bfmed.org/assets/DOCUMENTS/PROTOCOLS/3-supplementation-protocol-english.pdf)):

| Age | Intake per feed |
|---|---|
| 0–24 h | 2–10 mL |
| 24–48 h | 5–15 mL |
| 48–72 h | 15–30 mL |
| 72–96 h | 30–60 mL |

On day 1, measured intake averaged only about 1.5 g (about 1.5 mL) per feed, or about 15 g
for the whole day
([Santoro 2010](https://pubmed.ncbi.nlm.nih.gov/19783000/)).

**Breast milk per day.** Typical totals by age:

- **Day 5:** about 415–500 g, or about 400–485 mL
  ([Neville 1988](https://pubmed.ncbi.nlm.nih.gov/3202087/): 498 ± 129 g;
  [Kent 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC5188411/): 415 ± 123 g,
  pooled from seven earlier studies cited in Kent's introduction, not Kent's
  own sample).
- **Week 2:** about 650 mL (one small cited study of 10 mothers).
- **1–6 months:** a mean of 788 g, with a normal range of 478–1356 g (about
  464–1317 mL)
  (Kent 2006).
- **WHO-commissioned meta-analysis:** 624 mL at 1 month, 735 mL at 3 months and
  729 mL at 6 months, in infants exclusively breastfed through 6 months
  ([Rios-Leyvraz 2023](https://pubmed.ncbi.nlm.nih.gov/36763610/)).

**Breast milk per feed.** At 1–6 months a feed averages 76 g but ranges from 0
to 240 g, about 0–233 mL ([Kent 2006](https://pubmed.ncbi.nlm.nih.gov/16510619/)).

**Breast milk by body weight.** About 150 mL/kg a day is the conventional
figure. Intake peaks near day 20 and falls over the following months
([Yeung 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7083422/)).

The normal range is wide, so the app never flags breast-milk intake on its own.

**Formula.** Typical amounts by age, mostly from the
[AAP](https://www.healthychildren.org/English/ages-stages/baby/formula-feeding/Pages/Amount-and-Schedule-of-Formula-Feedings.aspx):

- **First week:** no more than 30–60 mL a feed. CDC gives the same 1–2 oz for
  the first days
  ([CDC](https://www.cdc.gov/infant-toddler-nutrition/formula-feeding/how-much-and-how-often.html)).
- **Month 1:** 90–120 mL a feed, every 3–4 h.
- **6 months:** 180–240 mL a feed, 4–5 times a day.
- **By body weight:** about 165 mL/kg a day (2.5 oz per lb).
- **Ceiling:** about 960 mL (32 oz) a day at most. The AAP page states 960 mL;
  the exact conversion is 946 mL.

## 6. Feeds per day

| Feeding | Expected | Source |
|---|---|---|
| Breastfed newborn, first ~4 weeks | 8–12 feeds / 24 h; flag below 8 | [CDC 2026](https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/how-much-and-how-often.html), [AAP](https://www.healthychildren.org/English/ages-stages/baby/breastfeeding/Pages/How-Often-to-Breastfeed.aspx) |
| Breastfed newborn, gaps between feeds | No more than ~2–3 h by day or 4 h at night | AAP (2015 page) |
| Breastfed, 1–6 months | 6–18 feeds / 24 h (mean 11) | [Kent 2006](https://pubmed.ncbi.nlm.nih.gov/16510619/) |
| Bottle-fed newborn | At least 8 feeds / 24 h, every 2–3 h | [AAP 2024](https://www.healthychildren.org/English/ages-stages/baby/feeding-nutrition/Pages/How-Often-and-How-Much-Should-Your-Baby-Eat.aspx) |
| Formula, 6 months | 4–5 feeds (AAP); 5–6 at 6–12 months (CDC) | AAP, CDC |

## 7. Weighted feeds (test weighing)

**How it works.** Weigh the baby before and after a breastfeed in the same
clothes. The difference in grams, divided by 1.03, approximates the milk taken
in mL.

**Accuracy.**

- **Under a research protocol.** On clinical-grade scales with duplicate
  weighings, error is within ±5 g
  ([Haase 2009](https://pubmed.ncbi.nlm.nih.gov/19739951/)) or a mean of 1.7 g
  ([Kinoshita 2025](https://pubmed.ncbi.nlm.nih.gov/39630512/)). These studies
  are in preterm infants.
- **Parents at home.** A 2024 study had parents test-weigh in the community,
  mostly older infants and toddlers, using a specific scale and protocol with
  researchers involved
  ([Esquerra-Zwiers 2024](https://link.springer.com/article/10.1186/s40795-024-00911-4)).
  It does not show that unsupervised home test weights of newborn breastfeeds
  are accurate.
- **In routine use.** A single test weight in newborns fed by bottle, cup or
  tube had 95% limits of about −12 to +15 mL against known intake, and the
  authors advised against using it clinically
  ([Savenije & Brand 2006](https://pubmed.ncbi.nlm.nih.gov/16717082/)). Those
  limits describe that study's setting, not the error of any home scale, age,
  feed size or technique.
- **For the app.** Show home test weights as approximate. No validated
  uncertainty exists for home test weighing, so the app does not draw error
  bars until a measurement contract (scale, technique, uncertainty model) is
  defined and checked.

**Scale precision.**

- The 2024 community study used an infant scale that reads to 2 g up to 6 kg
  ([Esquerra-Zwiers 2024](https://pubmed.ncbi.nlm.nih.gov/39054548/)). That is
  the scale it used, not a stated minimum.
- No allowed source states a minimum resolution. The common claim that
  "10 g kitchen or baby scales are inadequate" could not be verified.
- How scale resolution should affect a displayed uncertainty is deferred
  research. v1 has no validated uncertainty model and shows none.

**Insensible water loss.** Babies lose some water to evaporation during a feed.
The MILQ research protocol multiplies test weights by 1.05 to correct for this
([MILQ 2025](https://pubmed.ncbi.nlm.nih.gov/41167837/)). That factor belongs to
that protocol; it is not an established correction for every home feed.

**Clinical use.**

- Test weights are standard in NICUs before discharge
  ([Meier 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5328421/)).
- Estimating 24-hour production takes 2–4 full days of weighing every feed
  ([Roznowski 2020](https://pubmed.ncbi.nlm.nih.gov/32700964/)).
- One test-weighed feed says little about the day, because single feeds range
  from 0 to 240 g, about 0–233 mL (Kent 2006).

## 8. Pumping as an estimate of supply

Pump output is a poor estimate of what a baby drinks:

- **Babies leave milk behind.** A breastfeeding baby removes about 67% of the
  milk available in the breast, so some milk is normally left
  ([Kent 2006](https://pubmed.ncbi.nlm.nih.gov/16510619/)).
- **Pumps vary.** A pump at maximum comfortable vacuum removes about 65% of
  available milk, and less at lower vacuum
  ([Kent 2008](https://pubmed.ncbi.nlm.nih.gov/18333764/)).
- **Pumping overestimates intake.** In 16 paired measurements, a 3-hour pumping
  protocol estimated 1,085 g a day, against 717 g a day of measured infant
  intake. The authors
  call it valid for maternal production capacity "but … not accurate for
  evaluating infant intake"
  ([Roznowski 2020](https://pubmed.ncbi.nlm.nih.gov/32700964/)).
- **The preterm 500 mL target does not apply to term babies.** The ≥500 mL/day
  by day 14 target is for pump-dependent mothers of very-low-birth-weight NICU
  infants ([Hoban 2018](https://pubmed.ncbi.nlm.nih.gov/29377728/)).
- **No validated low-supply cut-off for term babies yet.** A 2025 cohort
  proposed 708 mL a day of milk production
  ([Jin 2025](https://pubmed.ncbi.nlm.nih.gov/41305574/)). It is a single study
  and is recorded as low confidence.
- **No guideline says otherwise.** No guideline from WHO, AAP, CDC, NICE or ABM
  endorses pump output as a home measure of supply.
- **ABM defines low supply by the baby's weight gain.** ABM Protocol #9 defines
  low supply clinically, for example when the infant is not gaining weight
  normally ([ABM #9, 2018](https://pubmed.ncbi.nlm.nih.gov/29902083/)).

## 9. Mismatch signals and dehydration

These combine entries from the data file. Each is a prompt to talk to the
pediatrician:

- **Frequent feeds but few diapers.** 8 or more feeds a day from day 5, but
  fewer than 6 wet diapers or fewer than 3 stools a day. Frequent feeding with
  low output suggests the baby is not transferring enough milk. Sources: CDC's
  call-the-doctor sign by day 5, AAP KidsDoc.
- **Feeds that look adequate but weight that does not follow.** The baby is
  still losing weight after day 5, or has lost more than 10%, or has not
  regained birth weight by day 14 (soft) or day 21 (firm).
- **Meconium persisting.** Still passing meconium on day 5, or fewer than 4
  stools on day 4 (ABM #3).
- **Long gaps between feeds.** Gaps longer than 3 h by day or 4 h at night in
  the first weeks (AAP).

Dehydration signs, from the
[AAP](https://www.healthychildren.org/English/health-issues/injuries-emergencies/Pages/dehydration.aspx)
and [NHS](https://www.nhs.uk/conditions/dehydration/):

- Fewer than 6 wet diapers a day (after day 5)
- Dark urine
- Dry mouth
- Few or no tears
- Sunken soft spot (fontanelle)
- Unusual sleepiness or irritability

Severe signs mean seek care now:

- Only 1–2 wet diapers a day
- No urine for more than 8 hours
- Sunken eyes
- Cool or mottled hands and feet
- Hard to wake

The app should say "seek care now" for severe signs and should never wait for a
threshold count.

## Milk-supply estimate: evidence

**The proposal.** The brief proposes estimating supply as estimated intake plus
the post-feed pump residual. The estimate would be shown as a range that narrows
as weighted feeds and weigh-ins accumulate.

**Verdict: partially supported. Defer the numeric supply estimate for v1.**

**What is supported:**

- **The definition.** The University of Western Australia group defines 24-hour
  milk production as milk transferred at the breast (by test weighing) plus all
  milk expressed, over a complete 24 hours: "total breastmilk production = total
  breastfeeding transfer + total breastmilk expressed"
  ([Kent 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC5188411/);
  [Jin 2025](https://pubmed.ncbi.nlm.nih.gov/41305574/)).
- **Residual milk.** Milk left in the breast after feeds is real, about 109 g
  a day at 3 months in the DARLING study (other ages were not reported). That study measured it as milk extracted by
  expression on a separate day minus test-weighed intake
  ([Dewey 1991](https://pubmed.ncbi.nlm.nih.gov/2034486/)).
- **Day-to-day variation.** A mother's daily total varies by about 9% from day
  to day (Dewey 1991).

**What is not supported, or is wrong as written:**

1. **Bottle volumes cannot count as intake.** In the research definition the
   intake term is breast transfer only. Adding bottles of expressed milk counts
   that milk twice, and adding formula counts it as supply.
2. **Post-feed pumping is an intervention, not a measurement.** Emptying the
   breast more fully raises milk synthesis
   ([Daly 1996](https://pubmed.ncbi.nlm.nih.gov/8889483/)), and pumping changes
   later output
   ([Roznowski 2020](https://pubmed.ncbi.nlm.nih.gov/32700964/)). Pumping to
   measure changes the quantity being measured.
3. **Partial data cannot be extrapolated.** Feed volume depends on the breast,
   the time of day and whether there were night feeds
   ([Kent 2006](https://pubmed.ncbi.nlm.nih.gov/16510619/)). A few daytime test
   weights give a biased estimate, not just a noisy one. The method is
   validated only with every feed weighed over 24 h, repeated for 2–4 days.
4. **Home test weights are imprecise, by an unknown amount.** No study gives a
   validated error for unsupervised home test weights of newborn breastfeeds
   (see section 7).
5. **The narrowing range is unvalidated.** No study validates an interval that
   narrows as sparse home measurements accumulate. Such an interval would
   reflect sampling noise only. It would leave out the ~9% day-to-day variation,
   the bias from the measurement method, and the effect of pumping itself.
6. **No guideline endorses it.** No guideline endorses home supply estimation
   by this method. ABM defines low supply by the baby's weight gain.

**What the app can show safely in v1:**

- Observed direct-breast intake from weighted feeds, shown as approximate and
  kept separate from pumped volume and bottle volume. Error bars wait for a
  validated uncertainty model.
- A total of milk removed over 24 hours, only when every feed and pumping
  session in that window was weighed or measured. Label it "milk removed in this
  period", not "supply".
- The baby's weight trajectory as the main signal that intake is adequate.

**Defer:**

- Any "supply" or "capacity" number.
- Any low-supply classification, including the 708 mL figure.
- Any prompt to pump after feeds in order to measure.

## Where sources disagree

| Topic | Position A | Position B |
|---|---|---|
| When 6+ wet diapers is expected | CDC: day 4 (and 5 on day 3) | AAP: day 4–5 (clinician page) or 5–7 (parent page); NHS and KidsDoc: from day 5. KidsDoc says 3 a day can be normal while milk comes in |
| Wet-diaper floor after the newborn period | AAP, CDC, NHS: 6 a day | AAP "Baby's First Days": "at least four diapers a day", probably fine (low confidence) |
| Stools on days 2–3 | CDC: at least 3 a day from day 2 | AAP: 1–2 a day on days 1–3 |
| Minimum stools around day 4–5 | ABM: 4 or more on day 4; AAP: 3–4 or more by day 5–7; KidsDoc: 3 or more | NHS: 2 or more from day 4 |
| When breastfed stools may become infrequent | AAP: from 3–6 weeks; KidsDoc: after 1 month | NHS and CDC: after about 6 weeks |
| Pale stool urgency | AAP article: "as soon as possible", single occurrence; NHS: urgent, keep a sample | AAP KidsDoc: office hours, if it happens 2 or more times |
| Biliary atresia onset | NIDDK: jaundice by 3–6 weeks | AAP: pale stools and jaundice by 4–6 weeks |
| Weight-loss flag | NICE and AAP: more than 10% | ABM: 8–10% or more on day 5 or later, or above the NEWT 75th percentile; older AAP 2005: more than 7% (low confidence, unverified primary) |
| Regaining birth weight | AAP: 7–14 days | NICE: refer if not regained by 21 days; Paul 2016: 14–24% still below birth weight at 14 days |
| Average first-month gain | AAP: about 28 g a day | WHO medians for 0–4 weeks: about 31 g a day (girls), 37 g a day (boys) |
| Falling-centile rule | AAP: 2 major percentile lines | NICE: 1, 2 or 3 centile spaces depending on birth-weight centile; CDC: below the 2.3rd percentile |
| Formula per feed, first days | AAP 2024: about 15 mL on days 1–2 | AAP 2022 and CDC: 30–60 mL; an AAP 2018 Q&A says 60–90 mL |
| 32 oz formula cap | AAP: a ceiling (960 mL as stated) | CDC: uses 32 oz only as a vitamin D cut-off |
| Breastfeeds per day | CDC and AAP 2015: 8–12 | AAP 2024: 10–12 is the norm |
| Breast milk on day 5 | Neville 1988: 498 g (about 483 mL) | Kent 2016: 415 g (about 403 mL), pooled from earlier studies |
| Test-weighing reliability | Savenije 2006: single test weights unreliable in that newborn setting (−12 to +15 mL), do not use clinically | Meier 1990, Haase 2009, Kinoshita 2025: accurate with protocol and scale (±2–5 g) in preterm infants; Esquerra-Zwiers 2024: parent-performed with a set scale and protocol, mostly older infants |
| Low supply | Hoban 2018: 500 mL a day by day 14 (preterm, pump-dependent) | Jin 2025: 708 mL a day (term, 4–26 weeks); not interchangeable |

## Verification notes

- **Fetch blocks.** Some sites blocked automated fetching, so their text was
  checked another way:
  - PubMed and PMC pages were checked through NCBI E-utilities or Europe PMC.
  - NICE NG75 and the ABM #3 PDF were checked with curl and local text
    extraction.
  - Every URL in the data file resolved at the time of writing. CDC pages
    return 403 to bare curl but load in a browser and in the fetch tool.
- **Not verified, and kept out of the data file or marked low confidence:**
  - The full text of the AAP 2012 and 2022 breastfeeding policy statements (403
    from publications.aap.org). The 7% weight-loss figure comes only from
    secondary citation of AAP 2005.
  - NICE NG194 and CG98 statements on meconium and pale stools (403).
  - StatPearls "Meconium" (captcha).
  - The newborn-weight.org NEWT site.
  - The "10 g scales are inadequate" claim.
  - Any official source for a day-by-day "1, 2, 3, 4, 5, 6+" wet-diaper
    series. Only commercial sites give one; CDC's table is used instead.
  - Kent 2006's 478–1356 g range is verified only through a citing review
    ([PMC10223764](https://pmc.ncbi.nlm.nih.gov/articles/PMC10223764/)); the
    abstract does not state it.
