import type { BabyEvent, Id, Stool, StoolColor, Timestamp } from '@bht/schema';
import { activeAt, canFlag, entry, isCitable, trips, type ThresholdEntry } from './entries.ts';
import {
  CHECK_IDS,
  URGENCIES,
  type CheckId,
  type CheckResult,
  type Citation,
  type EvaluateInput,
  type NotEnoughDataReason,
  type Observed,
  type ObservedUnit,
  type Urgency,
} from './types.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How far back Readings looks for a red-flag stool (pale, black, blood). App policy, not #11:
 * the reference gives no lookback (PM decision on #7, 2026-10-29). A flag stays visible for
 * the whole window; there is no "talked to the pediatrician" acknowledgement in v1.
 */
export const RED_FLAG_LOOKBACK_DAYS = 7;

/** The 8 h gap from no_urine_hours_dol2_4. */
const NO_URINE_HOURS = 8;

/**
 * Urgency of each entry when it flags, from the wording #11 quotes. Every other entry is
 * 'consider'. The strictest firing entry sets the result's urgency.
 */
const ENTRY_URGENCY: Readonly<Record<string, Urgency>> = {
  // KidsDoc: "Wet diapers are less than 6 per day" -> contact doctor within 24 hours.
  wet_diapers_min_aap_kidsdoc_from_dol5: 'within_24h',
  // #11 §9: only 1-2 wet diapers a day is a severe sign; seek care now.
  wet_diapers_severe_dehydration: 'now',
  // KidsDoc: day 2-4 and no urine in more than 8 hours -> contact doctor within 24 hours.
  no_urine_hours_dol2_4: 'within_24h',
  // KidsDoc: the 8 h gap with dark urine, no stool, dry mouth, no tears -> seek care now. It needs
  // signs v1 does not log (requires_signs), so canFlag keeps it from ever firing.
  no_urine_hours_dehydration: 'now',
  // #11 §2: any pale, clay or white stool -> call the pediatrician promptly.
  stool_pale_white_any: 'promptly',
};

const PALE: ReadonlySet<StoolColor> = new Set(['pale_yellow', 'clay', 'white']);

interface Ctx {
  birth: number;
  now: number;
  synced: number | null;
  sex: EvaluateInput['baby']['sex'];
  /** Fully logged periods, merged and sorted. */
  covered: [number, number][];
  /** Live events between birth and now, oldest first. */
  events: BabyEvent[];
}

/**
 * Runs every v1 check that applies at the baby's age. Pure: the same input gives the same
 * results. Results are sorted strictest first: flags by urgency, then "not enough data",
 * then ok.
 */
export function evaluate(input: EvaluateInput): CheckResult[] {
  const birth = Date.parse(input.baby.birthAt);
  const now = Date.parse(input.now);
  const ctx: Ctx = {
    birth,
    now,
    synced: input.syncedThrough === null ? null : Date.parse(input.syncedThrough),
    sex: input.baby.sex,
    covered: merge(input.fullyLogged.map((i) => [Date.parse(i.start), Date.parse(i.end)])),
    events: input.events
      .filter((e) => !e.deleted && at(e) >= birth && at(e) <= now)
      .sort((a, b) => at(a) - at(b)),
  };
  const results = [
    wetDiapers(ctx),
    noUrine(ctx),
    stools(ctx),
    firstStool(ctx),
    paleStool(ctx),
    blackStool(ctx),
    bloodInStool(ctx),
    weightLoss(ctx),
    weightTrend(ctx),
    birthWeightRegain(ctx),
    weightGain(ctx),
    feeds(ctx),
    formulaPerDay(ctx),
    formulaPerFeed(ctx),
  ].filter((r): r is CheckResult => r !== null);
  return results.sort((a, b) => rank(b) - rank(a) || order(a.check) - order(b.check));
}

function rank(r: CheckResult): number {
  if (r.status === 'flag') return 2 + URGENCIES.indexOf(r.urgency);
  return r.status === 'not_enough_data' ? 1 : 0;
}

function order(c: CheckId): number {
  return CHECK_IDS.indexOf(c);
}

// --- Counts over the latest completed day of life ---

function wetDiapers(ctx: Ctx): CheckResult | null {
  const d = latestCompletedDay(ctx);
  if (d === null) return null;
  const active = activeEntries(
    [
      'wet_diapers_min_cdc_dol1',
      'wet_diapers_min_cdc_dol2',
      'wet_diapers_min_cdc_dol3',
      'wet_diapers_min_cdc_dol4',
      'wet_diapers_min_cdc_dol5_7',
      'wet_diapers_min_aap_kidsdoc_from_dol5',
      'wet_diapers_min_nhs_from_dol5',
      'wet_diapers_min_aap_dehydration',
      'wet_diapers_min_aap_general',
      'wet_diapers_severe_dehydration',
    ],
    d * DAY_MS,
  );
  const wets = inDay(ctx, d).filter(isWet);
  return countCheck(ctx, 'wet_diapers', d, active, wets, (n, firing, min) => ({
    title: 'Fewer wet diapers than expected',
    why: firing.some((e) => e.id === 'wet_diapers_severe_dehydration')
      ? `Only ${plural(n, 'wet diaper')} logged on day ${d + 1} of life. The AAP lists only 1–2 wet diapers in a day as a sign of severe dehydration.`
      : `${plural(n, 'wet diaper')} logged on day ${d + 1} of life. ${orgs(firing)} expect at least ${min} at this age.`,
  }));
}

function stools(ctx: Ctx): CheckResult | null {
  const d = latestCompletedDay(ctx);
  if (d === null) return null;
  let active = activeEntries(
    [
      'stools_min_cdc_dol1',
      'stools_min_cdc_dol2_7',
      'stools_min_aap_dol3_4',
      'stools_min_abm_dol4',
      'stools_min_aap_from_dol5',
      'stools_min_nhs_from_dol4',
      'stools_min_formula',
    ],
    d * DAY_MS,
  );
  // From day 21 a low count is normal when stools are soft and weight gain is adequate
  // (stool_interval_breastfed_normal). #11 defines no test for "adequate", so v1 cannot rule
  // the exception out and the suppressible entries do not run (source exceptions win).
  const suppressor = entry('stool_interval_breastfed_normal');
  if (activeAt(suppressor, d * DAY_MS)) {
    active = active.filter((e) => !e.suppressed_by?.some((s) => s.id === suppressor.id));
  }
  const dirty = inDay(ctx, d).filter(isStool);
  return countCheck(ctx, 'stools', d, active, dirty, (n, firing, min) => ({
    title: 'Fewer stools than expected',
    why: `${plural(n, 'stool')} logged on day ${d + 1} of life. ${orgs(firing)} expect at least ${min} at this age.`,
  }));
}

function feeds(ctx: Ctx): CheckResult | null {
  const d = latestCompletedDay(ctx);
  if (d === null) return null;
  const logged = inDay(ctx, d).filter(
    (e) => e.type === 'breastfeed' || e.type === 'bottle' || e.type === 'weighted_feed',
  );
  const breast = logged.some((e) => e.type !== 'bottle');
  const bottle = logged.some((e) => e.type === 'bottle');
  const ids = [
    ...(breast || !bottle ? ['breastfeeds_min_newborn_cdc', 'breastfeeds_min_newborn_aap'] : []),
    ...(bottle || !breast ? ['bottle_feeds_min_newborn'] : []),
  ];
  return countCheck(ctx, 'feeds', d, activeEntries(ids, d * DAY_MS), logged, (n, firing, min) => ({
    title: 'Fewer feeds than expected',
    why: `${plural(n, 'feed')} logged on day ${d + 1} of life. ${orgs(firing)} expect at least ${min} feeds a day in the first weeks.`,
  }));
}

function formulaPerDay(ctx: Ctx): CheckResult | null {
  const d = latestCompletedDay(ctx);
  if (d === null) return null;
  const active = activeEntries(['formula_daily_max'], d * DAY_MS);
  const bottles = inDay(ctx, d).filter(isFormula);
  if (!active.some(canFlag) || bottles.length === 0) return null;
  const ml = bottles.reduce((sum, e) => sum + e.data.volumeMl, 0);
  const [start, end] = dayBounds(ctx, d);
  const observed = observe(ml, 'mL', active);
  const tripped = (e: ThresholdEntry) => trips(e, ml);
  // Over the ceiling is positive evidence; under it is a claim about the whole day.
  if (!active.some((e) => canFlag(e) && tripped(e))) {
    const gap = coverage(ctx, start, end);
    if (gap) return notEnough('formula_per_day', start, end, active, gap, observed);
  }
  return decide('formula_per_day', start, end, active, observed, tripped, ids(bottles), () => ({
    title: 'More formula than the daily ceiling',
    why: `About ${Math.round(ml)} mL of formula logged on day ${d + 1} of life. The AAP gives about 960 mL (32 oz) a day as the most a baby should need.`,
  }));
}

function formulaPerFeed(ctx: Ctx): CheckResult | null {
  const d = latestCompletedDay(ctx);
  if (d === null) return null;
  const active = activeEntries(['formula_per_feed_week1_max'], d * DAY_MS);
  const bottles = inDay(ctx, d).filter(isFormula);
  if (!active.some(canFlag) || bottles.length === 0) return null;
  const largest = Math.max(...bottles.map((e) => e.data.volumeMl));
  const [start, end] = dayBounds(ctx, d);
  const tripped = (e: ThresholdEntry) => trips(e, largest);
  const over = bottles.filter((b) => active.some((e) => canFlag(e) && trips(e, b.data.volumeMl)));
  return decide(
    'formula_per_feed',
    start,
    end,
    active,
    observe(largest, 'mL', active),
    tripped,
    ids(over),
    () => ({
      title: 'Large formula feeds for the first week',
      why: `A ${Math.round(largest)} mL formula feed was logged on day ${d + 1} of life. The AAP says no more than about 30–60 mL a feed in the first week.`,
    }),
  );
}

type Wording = (
  n: number,
  firing: ThresholdEntry[],
  min: number | undefined,
) => {
  title: string;
  why: string;
};

/** A minimum count over one completed day. Runs only if the day is fully logged and synced. */
function countCheck(
  ctx: Ctx,
  check: CheckId,
  d: number,
  active: ThresholdEntry[],
  matched: BabyEvent[],
  wording: Wording,
): CheckResult | null {
  if (!active.some(canFlag)) return null;
  const [start, end] = dayBounds(ctx, d);
  const n = matched.length;
  const observed = observe(n, 'count', active);
  const gap = coverage(ctx, start, end);
  if (gap) return notEnough(check, start, end, active, gap, observed);
  return decide(
    check,
    start,
    end,
    active,
    observed,
    (e) => trips(e, n),
    ids(matched),
    (firing) => wording(n, firing, observed.expected.min),
  );
}

// --- Absence over hours ---

/**
 * No wet diaper for more than 8 h on days 2-4 of life (no_urine_hours_dol2_4). The gap is
 * measured back from the last sync, because an unsynced wet diaper on the other phone may
 * fill it. The composite dehydration entry is cited but never flags (it needs signs v1 does
 * not log). There is no gap check on day 1 or after day 4.
 */
function noUrine(ctx: Ctx): CheckResult | null {
  const age = ctx.now - ctx.birth;
  const rule = entry('no_urine_hours_dol2_4');
  if (!activeAt(rule, age)) return null;
  const active = activeEntries(['no_urine_hours_dol2_4', 'no_urine_hours_dehydration'], age);
  const end = ctx.synced === null ? ctx.now : Math.min(ctx.now, ctx.synced);
  const start = end - NO_URINE_HOURS * HOUR_MS;
  const wets = ctx.events.filter(isWet);
  const last = wets.at(-1);
  const hoursSince = (t: number) => (t - (last ? at(last) : ctx.birth)) / HOUR_MS;
  // A wet diaper anywhere from the window start to now, synced or not, answers the check.
  if (last && at(last) >= start) {
    const observed = observe(hoursSince(ctx.now), 'h', active);
    return decide('no_urine', start, end, active, observed, () => false, [], noWording);
  }
  // Hours from the last logged wet diaper (or birth) to the end of the window: over 8.
  const hours = hoursSince(end);
  const observed = observe(hours, 'h', active);
  const gap = ctx.synced === null ? 'not_synced' : coverage(ctx, start, end);
  if (gap) return notEnough('no_urine', start, end, active, gap, last ? observed : undefined);
  return decide(
    'no_urine',
    start,
    end,
    active,
    observed,
    (e) => trips(e, hours),
    last ? [last.id] : [],
    () => ({
      title: 'No wet diaper for over 8 hours',
      why: `No wet diaper was logged in the 8 hours before the last sync. The AAP says a baby on days 2–4 of life with no urine for more than 8 hours should see a doctor within 24 hours.`,
    }),
  );
}

/** First stool after 48 h of age (first_meconium_hours). Applies until 72 h. */
function firstStool(ctx: Ctx): CheckResult | null {
  const age = ctx.now - ctx.birth;
  const active = activeEntries(['first_meconium_hours'], age);
  if (!active.some(canFlag)) return null;
  const rule = entry('first_meconium_hours');
  const limit = ctx.birth + (rule.value as number) * HOUR_MS;
  const first = ctx.events.find(isStool);
  const hours = first ? (at(first) - ctx.birth) / HOUR_MS : age / HOUR_MS;
  const observed = observe(hours, 'h', active);
  const tripped = (e: ThresholdEntry) => trips(e, hours);
  if (first && !tripped(rule)) {
    return decide('first_stool', ctx.birth, at(first), active, observed, tripped, [], noWording);
  }
  // No stool yet, and the 48 hours are not over: nothing to say.
  if (!first && ctx.now <= limit) return null;
  // A later first stool proves nothing about the first 48 h unless they were fully logged.
  const gap = coverage(ctx, ctx.birth, limit);
  if (gap) return notEnough('first_stool', ctx.birth, limit, active, gap, observed);
  return decide(
    'first_stool',
    ctx.birth,
    limit,
    active,
    observed,
    tripped,
    first ? [first.id] : [],
    () => ({
      title: 'No stool in the first 48 hours',
      why: 'No stool was logged in the first 48 hours. The NHS says the first stool (meconium) is usually passed within 48 hours.',
    }),
  );
}

// --- Red-flag stools: positive evidence over the lookback ---

function paleStool(ctx: Ctx): CheckResult | null {
  return redFlag(
    ctx,
    'pale_stool',
    ['stool_pale_white_any', 'stool_pale_white_repeated'],
    (e) => {
      const color = stoolOf(e)?.color;
      return color != null && PALE.has(color);
    },
    (n) => ({
      title: 'Pale stool logged',
      why: `${plural(n, 'pale, clay or white stool')} logged in the last ${RED_FLAG_LOOKBACK_DAYS} days. Pale stool can be a sign of a liver problem (biliary atresia) and needs a doctor's attention as soon as possible (AAP). Keep a sample or a photo (NHS).`,
    }),
  );
}

function blackStool(ctx: Ctx): CheckResult | null {
  return redFlag(
    ctx,
    'black_stool',
    ['stool_black_after_meconium', 'meconium_persisting_dol5'],
    (e) => stoolOf(e)?.color === 'black',
    (n, firing) => ({
      title: 'Black stool after the first days',
      why: firing.some((e) => e.id === 'meconium_persisting_dol5')
        ? `${plural(n, 'black stool')} logged from day 6 of life. Meconium still passing on day 5 is a reason to have the baby evaluated (ABM), and by day 5 black stools are not normal (AAP).`
        : `${plural(n, 'black stool')} logged after day 4 of life. By day 5, black or dark green stools are not normal (AAP).`,
    }),
  );
}

function bloodInStool(ctx: Ctx): CheckResult | null {
  return redFlag(
    ctx,
    'blood_in_stool',
    ['stool_red_blood_any'],
    (e) => {
      const stool = stoolOf(e);
      return stool?.color === 'red' || (stool?.flags.includes('blood') ?? false);
    },
    (n) => ({
      title: 'Red stool or blood logged',
      why: `${plural(n, 'stool')} with red colour or blood logged in the last ${RED_FLAG_LOOKBACK_DAYS} days. Swallowed blood from a cracked nipple is a common harmless cause, but tell your pediatrician. Large amounts of blood, mucus or water mean call immediately (AAP).`,
    }),
  );
}

/**
 * Counts matching stools over the lookback. An entry counts only stools passed while its own
 * age window was open, so a black stool at 119 h counts for the day-5 black-stool rule but not
 * for ABM's meconium rule, which starts at 120 h. Positive evidence: no coverage needed, and
 * `ok` means none was logged.
 */
function redFlag(
  ctx: Ctx,
  check: CheckId,
  entryIds: string[],
  match: (e: BabyEvent) => boolean,
  wording: (n: number, firing: ThresholdEntry[]) => { title: string; why: string },
): CheckResult | null {
  const active = activeEntries(entryIds, ctx.now - ctx.birth);
  if (!active.some(canFlag)) return null;
  const start = Math.max(ctx.birth, ctx.now - RED_FLAG_LOOKBACK_DAYS * DAY_MS);
  const counts = (e: ThresholdEntry) =>
    ctx.events.filter((ev) => at(ev) >= start && match(ev) && activeAt(e, at(ev) - ctx.birth));
  const matched = ctx.events.filter(
    (ev) => at(ev) >= start && match(ev) && active.some((e) => activeAt(e, at(ev) - ctx.birth)),
  );
  return decide(
    check,
    start,
    ctx.now,
    active,
    observe(matched.length, 'count', active),
    (e) => trips(e, counts(e).length),
    ids(matched),
    (firing) => wording(matched.length, firing),
  );
}

// --- Weight ---

/** Birth weight is the first weight event, and only if it was logged in the first 24 h. */
function birthWeight(ctx: Ctx): WeightEvent | null {
  const first = weights(ctx)[0];
  return first && at(first) - ctx.birth < DAY_MS ? first : null;
}

function weightLoss(ctx: Ctx): CheckResult | null {
  const ids = ['weight_loss_max_pct_10', 'weight_loss_abm_pct_8_from_dol5'];
  const present = activeEntries(ids, ctx.now - ctx.birth);
  if (!present.some(canFlag)) return null;
  const birth = birthWeight(ctx);
  if (!birth) return notEnough('weight_loss', ctx.birth, ctx.now, present, 'no_birth_weight');
  const latest = weights(ctx).at(-1);
  if (!latest || latest === birth) {
    return notEnough('weight_loss', at(birth), ctx.now, present, 'no_recent_weight');
  }
  // Each rule applies at the age the weight was taken (ABM: loss "on day 5 or later").
  const active = activeEntries(ids, at(latest) - ctx.birth);
  const bw = birth.data.grams;
  const pct = ((bw - latest.data.grams) * 100) / bw;
  return decide(
    'weight_loss',
    at(birth),
    at(latest),
    active,
    observe(pct, 'pct', active),
    (e) => trips(e, pct),
    [birth.id, latest.id],
    (firing) => ({
      title: 'More weight lost than expected',
      why: firing.some((e) => e.id === 'weight_loss_max_pct_10')
        ? `${fmt(pct)}% below birth weight. NICE and the AAP advise having the baby assessed when more than 10% of birth weight is lost.`
        : `${fmt(pct)}% below birth weight on day ${dayOfLife(ctx, latest)} of life. The ABM advises a careful assessment at 8% or more from day 5.`,
    }),
  );
}

/**
 * Still losing weight after day 5 (weight_still_losing_after_dol5). Compares the latest
 * weight with an earlier one at least 2 days before it, both taken from day 5, because home
 * scales are noisy (the entry's notes).
 */
function weightTrend(ctx: Ctx): CheckResult | null {
  const rule = entry('weight_still_losing_after_dol5');
  const present = activeEntries([rule.id], ctx.now - ctx.birth);
  if (!present.some(canFlag)) return null;
  const from = ctx.birth + (rule.age_range.from_days ?? 0) * DAY_MS;
  const later = weights(ctx).filter((w) => at(w) >= from);
  const latest = later.at(-1);
  const prior = latest && later.filter((w) => at(w) <= at(latest) - 2 * DAY_MS).at(-1);
  if (!latest || !prior) {
    return notEnough('weight_trend', from, ctx.now, present, 'no_recent_weight');
  }
  const perDay = (latest.data.grams - prior.data.grams) / ((at(latest) - at(prior)) / DAY_MS);
  return decide(
    'weight_trend',
    at(prior),
    at(latest),
    present,
    observe(perDay, 'g/day', present),
    (e) => trips(e, perDay),
    [prior.id, latest.id],
    () => ({
      title: 'Still losing weight after day 5',
      why: `Weight fell by about ${Math.round(-perDay)} g a day between the last two weigh-ins. From about 5 days old, babies should start gaining weight steadily (AAP).`,
    }),
  );
}

/**
 * Not back to birth weight at 14 days (AAP, soft) or 21 days (NICE). Judged at the age of the
 * latest weight, so an old weight cannot say the baby is still below birth weight now. Once
 * any weight reaches birth weight, the flags clear.
 */
function birthWeightRegain(ctx: Ctx): CheckResult | null {
  const ids = ['regain_birth_weight_aap_days', 'regain_birth_weight_nice_days'];
  const present = activeEntries(ids, ctx.now - ctx.birth);
  if (!present.some(canFlag)) return null;
  const birth = birthWeight(ctx);
  if (!birth)
    return notEnough('birth_weight_regain', ctx.birth, ctx.now, present, 'no_birth_weight');
  const bw = birth.data.grams;
  const after = weights(ctx).filter((w) => w !== birth);
  const best = after.reduce<WeightEvent | undefined>(
    (m, w) => (!m || w.data.grams > m.data.grams ? w : m),
    undefined,
  );
  if (best && best.data.grams >= bw) {
    return decide(
      'birth_weight_regain',
      at(birth),
      at(best),
      present,
      observeExpected(best.data.grams - bw, 'g', { min: 0 }),
      () => false,
      [],
      noWording,
    );
  }
  const latest = after.at(-1);
  const active = latest ? activeEntries(ids, at(latest) - ctx.birth) : [];
  if (!latest || !active.some(canFlag)) {
    return notEnough('birth_weight_regain', at(birth), ctx.now, present, 'no_recent_weight');
  }
  const days = Math.floor((at(latest) - ctx.birth) / DAY_MS);
  return decide(
    'birth_weight_regain',
    at(birth),
    at(latest),
    active,
    observeExpected(latest.data.grams - bw, 'g', { min: 0 }),
    (e) => trips(e, days),
    [birth.id, latest.id],
    (firing) => ({
      title: 'Not back to birth weight',
      why: firing.some((e) => e.id === 'regain_birth_weight_nice_days')
        ? `Still below birth weight at ${days} days old. NICE advises considering referral if birth weight is not regained by 3 weeks.`
        : `Still below birth weight at ${days} days old. The AAP expects birth weight to be regained by 7–14 days.`,
    }),
  );
}

/** WHO weight-velocity tolerance around each scheduled measurement age (#11 §4). */
const WHO_TOLERANCE_MS = 3 * DAY_MS;

/**
 * Weight gained over the WHO interval that just ended, against the 5th percentile. Uses the
 * weights nearest each end of the interval within ±3 days; never interpolates.
 */
function weightGain(ctx: Ctx): CheckResult | null {
  const age = ctx.now - ctx.birth;
  const candidates = WHO_ENTRY_IDS.map(entry).filter((e) => activeAt(e, age));
  if (candidates.length === 0) return null;
  const mine = candidates.filter((e) => e.sex === ctx.sex);
  if (mine.length === 0) {
    return notEnough('weight_gain', ctx.birth, ctx.now, candidates, 'sex_unknown');
  }
  const rule = mine[0]!;
  const interval = rule.interval!;
  const start = ctx.birth + interval.from_days * DAY_MS;
  const end = ctx.birth + interval.to_days * DAY_MS;
  const a = nearestWeight(ctx, start);
  const b = nearestWeight(ctx, end);
  if (!a || !b || a === b) {
    return notEnough('weight_gain', start, end, mine, 'no_weight_near_interval_end');
  }
  const gain = b.data.grams - a.data.grams;
  return decide(
    'weight_gain',
    start,
    end,
    mine,
    observe(gain, 'g', mine),
    (e) => trips(e, gain),
    [a.id, b.id],
    () => ({
      title: 'Weight gain below the 5th percentile',
      why: `Gained ${gain} g between days ${interval.from_days} and ${interval.to_days}. The WHO 5th percentile for this interval is ${rule.value as number} g. By definition 5% of healthy babies fall below it, so mention it at the next visit.`,
    }),
  );
}

const WHO_ENTRY_IDS = ['0_4w', '4w_2m', '2_3m', '3_4m', '4_5m', '5_6m'].flatMap((span) => [
  `weight_gain_who_p5_${span}_male`,
  `weight_gain_who_p5_${span}_female`,
]);

function nearestWeight(ctx: Ctx, target: number): WeightEvent | undefined {
  let best: WeightEvent | undefined;
  for (const w of weights(ctx)) {
    const dist = Math.abs(at(w) - target);
    if (dist <= WHO_TOLERANCE_MS && (!best || dist < Math.abs(at(best) - target))) best = w;
  }
  return best;
}

// --- Shared machinery ---

type WeightEvent = Extract<BabyEvent, { type: 'weight' }>;

function weights(ctx: Ctx): WeightEvent[] {
  return ctx.events.filter((e): e is WeightEvent => e.type === 'weight');
}

function activeEntries(ids: string[], ageMs: number): ThresholdEntry[] {
  return ids.map(entry).filter((e) => isCitable(e) && activeAt(e, ageMs));
}

function urgencyOf(e: ThresholdEntry): Urgency {
  return ENTRY_URGENCY[e.id] ?? 'consider';
}

const CONFIDENCE_ORDER = { high: 0, moderate: 1, low: 2 } as const;

function decide(
  check: CheckId,
  start: number,
  end: number,
  active: ThresholdEntry[],
  observed: Observed,
  tripped: (e: ThresholdEntry) => boolean,
  evidence: Id[],
  wording: (firing: ThresholdEntry[]) => { title: string; why: string },
): CheckResult {
  const firing = active
    .filter((e) => canFlag(e) && tripped(e))
    .sort(
      (a, b) =>
        URGENCIES.indexOf(urgencyOf(b)) - URGENCIES.indexOf(urgencyOf(a)) ||
        CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence],
    );
  const citations = cite(active, firing);
  const window = { start: iso(start), end: iso(end) };
  if (firing.length === 0) return { check, window, citations, status: 'ok', observed };
  return {
    check,
    window,
    citations,
    status: 'flag',
    urgency: urgencyOf(firing[0]!),
    ...wording(firing),
    observed,
    evidence,
  };
}

function notEnough(
  check: CheckId,
  start: number,
  end: number,
  active: ThresholdEntry[],
  reason: NotEnoughDataReason,
  observed?: Observed,
): CheckResult {
  return {
    check,
    window: { start: iso(start), end: iso(end) },
    citations: cite(active, []),
    status: 'not_enough_data',
    reason,
    ...(observed ? { observed } : {}),
  };
}

const noWording = () => ({ title: '', why: '' });

/** Firing entries first (strictest first), then the rest by confidence. */
function cite(active: ThresholdEntry[], firing: ThresholdEntry[]): Citation[] {
  const rest = active
    .filter((e) => !firing.includes(e))
    .sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]);
  return [...firing, ...rest].map((e) => ({
    entryId: e.id,
    organization: e.source.organization,
    title: e.source.title,
    url: e.source.url,
    confidence: e.confidence,
  }));
}

/**
 * The scale bound from the entry that would flag first: the highest minimum, or the lowest
 * maximum, among entries that can flag.
 */
function observe(value: number, unit: ObservedUnit, active: ThresholdEntry[]): Observed {
  const flaggable = active.filter(canFlag);
  const mins = flaggable
    .filter((e) => e.op === 'lt' || e.op === 'lte')
    .map((e) => e.value as number);
  const maxes = flaggable
    .filter((e) => e.op === 'gt' || e.op === 'gte')
    .map((e) => e.value as number);
  return observeExpected(value, unit, {
    ...(mins.length ? { min: Math.max(...mins) } : {}),
    ...(maxes.length ? { max: Math.min(...maxes) } : {}),
  });
}

function observeExpected(
  value: number,
  unit: ObservedUnit,
  expected: Observed['expected'],
): Observed {
  return { value, unit, expected };
}

/** Is [start, end] inside the fully-logged periods, and synced by both phones? */
function coverage(ctx: Ctx, start: number, end: number): NotEnoughDataReason | null {
  if (ctx.synced === null || end > ctx.synced) return 'not_synced';
  const span = ctx.covered.find(([s, e]) => s <= start && end <= e);
  return span ? null : 'not_fully_logged';
}

/** Sorted, with overlapping or touching periods joined, so back-to-back days cover a span. */
function merge(intervals: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of [...intervals].filter(([s, e]) => s < e).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Day-of-life windows are aligned to birthAt. Day index 0 is day of life 1. */
function latestCompletedDay(ctx: Ctx): number | null {
  const d = Math.floor((ctx.now - ctx.birth) / DAY_MS) - 1;
  return d >= 0 ? d : null;
}

function dayBounds(ctx: Ctx, d: number): [number, number] {
  return [ctx.birth + d * DAY_MS, ctx.birth + (d + 1) * DAY_MS];
}

function inDay(ctx: Ctx, d: number): BabyEvent[] {
  const [start, end] = dayBounds(ctx, d);
  return ctx.events.filter((e) => at(e) >= start && at(e) < end);
}

function dayOfLife(ctx: Ctx, e: BabyEvent): number {
  return Math.floor((at(e) - ctx.birth) / DAY_MS) + 1;
}

type DiaperEvent = Extract<BabyEvent, { type: 'diaper' }>;
type BottleEvent = Extract<BabyEvent, { type: 'bottle' }>;

/** A mixed diaper counts as both wet and dirty. */
function isWet(e: BabyEvent): e is DiaperEvent {
  return e.type === 'diaper' && (e.data.kind === 'wet' || e.data.kind === 'mixed');
}

function isStool(e: BabyEvent): e is DiaperEvent {
  return e.type === 'diaper' && (e.data.kind === 'dirty' || e.data.kind === 'mixed');
}

/** Stool details of a dirty or mixed diaper; null when none were entered. */
function stoolOf(e: BabyEvent): Stool | null {
  return e.type === 'diaper' && e.data.kind !== 'wet' ? e.data.stool : null;
}

function isFormula(e: BabyEvent): e is BottleEvent {
  return e.type === 'bottle' && e.data.contents === 'formula';
}

function at(e: BabyEvent): number {
  return Date.parse(e.occurredAt);
}

function iso(ms: number): Timestamp {
  return new Date(ms).toISOString();
}

function ids(events: BabyEvent[]): Id[] {
  return events.map((e) => e.id);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** "AAP (HealthyChildren.org)" -> "AAP"; joined as "CDC, AAP and NHS". */
function orgs(firing: ThresholdEntry[]): string {
  const names = [...new Set(firing.map((e) => e.source.organization.split(' (')[0]!))];
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
