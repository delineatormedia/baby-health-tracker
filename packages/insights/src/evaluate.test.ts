import { newId, parseEvent, type BabyEvent, type Sex } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { evaluate } from './evaluate.ts';
import type { CheckId, CheckResult } from './types.ts';

const H = 3_600_000;
const D = 24 * H;
const BIRTH = Date.parse('2026-01-01T00:00:00.000Z');
const BABY = newId();
const AUTHOR = newId();

const iso = (offsetMs: number) => new Date(BIRTH + offsetMs).toISOString();

function ev(type: BabyEvent['type'], offsetMs: number, data: unknown): BabyEvent {
  const r = parseEvent({
    id: newId(),
    babyId: BABY,
    authorId: AUTHOR,
    occurredAt: iso(offsetMs),
    recordedAt: iso(offsetMs),
    version: 1,
    deleted: false,
    notes: null,
    type,
    data,
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}

const wet = (t: number) => ev('diaper', t, { kind: 'wet' });
const mixed = (t: number) => ev('diaper', t, { kind: 'mixed', stool: null });
const dirty = (t: number, color: string | null = null, flags: string[] = []) =>
  ev('diaper', t, {
    kind: 'dirty',
    stool: { color, consistency: null, size: null, flags },
  });
const weight = (t: number, grams: number) => ev('weight', t, { grams, source: 'home' });
const breastfeed = (t: number) => ev('breastfeed', t, { side: 'left', durationSeconds: 600 });
const bottle = (t: number, volumeMl: number, contents = 'formula') =>
  ev('bottle', t, { contents, volumeMl });

/** n events spread evenly through day index d. */
function inDay(d: number, n: number, make: (t: number) => BabyEvent): BabyEvent[] {
  return Array.from({ length: n }, (_, i) => make(d * D + ((i + 0.5) * D) / n));
}

interface Run {
  now: number;
  events?: BabyEvent[];
  /** Fully logged periods as [start, end] offsets; default: birth to now. */
  logged?: [number, number][];
  /** Default: now. */
  synced?: number | null;
  sex?: Sex;
}

function run({ now, events = [], logged, synced, sex = 'female' }: Run): CheckResult[] {
  return evaluate({
    baby: { birthAt: iso(0), sex },
    events,
    now: iso(now),
    fullyLogged: (logged ?? [[0, now]]).map(([s, e]) => ({ start: iso(s), end: iso(e) })),
    syncedThrough: synced === null ? null : iso(synced ?? now),
  });
}

function check(results: CheckResult[], id: CheckId): CheckResult | undefined {
  return results.find((r) => r.check === id);
}

function get(r: Run, id: CheckId): CheckResult {
  const c = check(run(r), id);
  if (!c) throw new Error(`${id} did not run`);
  return c;
}

function flag(r: Run, id: CheckId) {
  const c = get(r, id);
  if (c.status !== 'flag') throw new Error(`${id} is ${c.status}, expected flag`);
  return c;
}

const status = (r: Run, id: CheckId) => check(run(r), id)?.status ?? 'absent';
const cited = (c: CheckResult) => c.citations.map((x) => x.entryId);

/** Now is just after day index d completes, so d is the latest completed day. */
const after = (d: number) => (d + 1) * D + H;

describe('wet diapers (day-of-life counts)', () => {
  test.each([
    // [day index, flags below, ok at]
    [0, 0, 1],
    [1, 1, 2],
    [2, 4, 5],
    [3, 5, 6],
    [4, 5, 6],
    [10, 5, 6],
  ])('day index %i: %i flags, %i is ok', (d, low, ok) => {
    expect(status({ now: after(d), events: inDay(d, low, wet) }, 'wet_diapers')).toBe('flag');
    expect(status({ now: after(d), events: inDay(d, ok, wet) }, 'wet_diapers')).toBe('ok');
  });

  test('does not run before day of life 1 is complete', () => {
    expect(status({ now: D - 1 }, 'wet_diapers')).toBe('absent');
    expect(status({ now: D }, 'wet_diapers')).toBe('flag');
  });

  test('day windows align to birthAt: start inclusive, end exclusive', () => {
    expect(status({ now: after(0), events: [wet(0)] }, 'wet_diapers')).toBe('ok');
    expect(status({ now: after(0), events: [wet(D)] }, 'wet_diapers')).toBe('flag');
  });

  test('before day 5 the soft CDC minimum flags as consider', () => {
    expect(flag({ now: after(3), events: inDay(3, 5, wet) }, 'wet_diapers').urgency).toBe(
      'consider',
    );
  });

  test('from day 5, under 6 is KidsDoc "within 24 hours"; 2 or fewer is "seek care now"', () => {
    const at = (n: number) => flag({ now: after(4), events: inDay(4, n, wet) }, 'wet_diapers');
    expect(at(5).urgency).toBe('within_24h');
    expect(at(3).urgency).toBe('within_24h');
    expect(at(2).urgency).toBe('now');
    expect(at(2).why).toMatch(/severe dehydration/);
    expect(cited(at(2))[0]).toBe('wet_diapers_severe_dehydration');
  });

  test('a mixed diaper counts as wet; deleted diapers do not count', () => {
    const six = inDay(4, 6, mixed);
    expect(status({ now: after(4), events: six }, 'wet_diapers')).toBe('ok');
    const gone = { ...six[0]!, deleted: true };
    expect(status({ now: after(4), events: [gone, ...six.slice(1)] }, 'wet_diapers')).toBe('flag');
  });

  test('low-confidence AAP "at least four" is cited but never decides', () => {
    const c = flag({ now: after(7), events: inDay(7, 3, wet) }, 'wet_diapers');
    expect(cited(c)).toContain('wet_diapers_min_aap_general');
    expect(c.citations.at(-1)?.confidence).toBe('low');
    expect(c.observed.expected).toEqual({ min: 6 });
  });

  test('flag carries the counted diapers as evidence and the strictest minimum', () => {
    const events = inDay(4, 4, wet);
    const c = flag({ now: after(4), events }, 'wet_diapers');
    expect(c.evidence).toEqual(events.map((e) => e.id));
    expect(c.observed).toEqual({ value: 4, unit: 'count', expected: { min: 6 } });
    expect(c.window).toEqual({ start: iso(4 * D), end: iso(5 * D) });
  });
});

describe('not enough data for counts', () => {
  const d = 4;
  const events = inDay(d, 3, wet);

  test('day not marked fully logged, with the partial count as context', () => {
    const c = get({ now: after(d), events, logged: [[0, d * D + H]] }, 'wet_diapers');
    expect(c).toMatchObject({ status: 'not_enough_data', reason: 'not_fully_logged' });
    expect(c.status === 'not_enough_data' && c.observed?.value).toBe(3);
  });

  test('missing logs are never evidence: no marks means no flag', () => {
    expect(get({ now: after(d), logged: [] }, 'wet_diapers')).toMatchObject({
      status: 'not_enough_data',
      reason: 'not_fully_logged',
    });
  });

  test('both phones not synced through the end of the day', () => {
    expect(get({ now: after(d), events, synced: (d + 1) * D - 1 }, 'wet_diapers')).toMatchObject({
      status: 'not_enough_data',
      reason: 'not_synced',
    });
    expect(get({ now: after(d), events, synced: null }, 'wet_diapers')).toMatchObject({
      status: 'not_enough_data',
      reason: 'not_synced',
    });
    expect(status({ now: after(d), events, synced: (d + 1) * D }, 'wet_diapers')).toBe('flag');
  });

  test('back-to-back marks cover the day between them', () => {
    const logged: [number, number][] = [
      [(d + 0.5) * D, (d + 1) * D],
      [d * D, (d + 0.5) * D],
    ];
    expect(status({ now: after(d), events, logged }, 'wet_diapers')).toBe('flag');
    const holed: [number, number][] = [
      [d * D, (d + 0.5) * D - 1],
      [(d + 0.5) * D, (d + 1) * D],
    ];
    expect(status({ now: after(d), events, logged: holed }, 'wet_diapers')).toBe('not_enough_data');
  });
});

describe('stools', () => {
  test.each([
    [0, 0, 1], // CDC day 1
    [1, 2, 3], // CDC days 2-7: fewer than 3 (AAP 1-2 is context only)
    [3, 3, 4], // ABM: fewer than 4 on day 4
    [4, 2, 3], // AAP from day 5
    [20, 2, 3],
  ])('day index %i: %i flags, %i is ok', (d, low, ok) => {
    expect(status({ now: after(d), events: inDay(d, low, (t) => dirty(t)) }, 'stools')).toBe(
      'flag',
    );
    expect(status({ now: after(d), events: inDay(d, ok, (t) => dirty(t)) }, 'stools')).toBe('ok');
  });

  test('from day 21 low counts may be normal, and the low-confidence formula rule never runs alone', () => {
    expect(status({ now: after(21) }, 'stools')).toBe('absent');
    expect(status({ now: after(60) }, 'stools')).toBe('absent');
  });

  test('a mixed diaper counts as a stool', () => {
    expect(status({ now: after(4), events: inDay(4, 3, mixed) }, 'stools')).toBe('ok');
  });
});

describe('no urine for more than 8 hours (days 2-4 only)', () => {
  const now = 30 * H;

  test('a wet diaper exactly 8 h before the sync is fine; a millisecond earlier flags', () => {
    expect(status({ now, events: [wet(now - 8 * H)] }, 'no_urine')).toBe('ok');
    const c = flag({ now, events: [wet(now - 8 * H - 1)] }, 'no_urine');
    expect(c.urgency).toBe('within_24h');
    expect(c.observed.value).toBeGreaterThan(8);
  });

  test('the composite "seek care now" entry is cited but never flags on its own', () => {
    const c = flag({ now, events: [] }, 'no_urine');
    expect(c.urgency).toBe('within_24h');
    expect(cited(c)).toEqual(['no_urine_hours_dol2_4', 'no_urine_hours_dehydration']);
  });

  test('no gap check on day of life 1 or after day 4', () => {
    expect(status({ now: D - 1 }, 'no_urine')).toBe('absent');
    expect(status({ now: D }, 'no_urine')).toBe('flag');
    expect(status({ now: 4 * D - 1 }, 'no_urine')).toBe('flag');
    expect(status({ now: 4 * D }, 'no_urine')).toBe('absent');
  });

  test('the gap is measured back from the last sync', () => {
    const synced = 28 * H;
    expect(status({ now, synced, events: [wet(synced - 8 * H - 1)] }, 'no_urine')).toBe('flag');
    // An unsynced wet diaper on this phone still answers it.
    expect(status({ now, synced, events: [wet(29 * H)] }, 'no_urine')).toBe('ok');
  });

  test('not enough data when the 8 hours are not fully logged or nothing has synced', () => {
    expect(get({ now, logged: [[0, now - H]], synced: now }, 'no_urine')).toMatchObject({
      status: 'not_enough_data',
      reason: 'not_fully_logged',
    });
    expect(get({ now, synced: null }, 'no_urine')).toMatchObject({
      status: 'not_enough_data',
      reason: 'not_synced',
    });
  });
});

describe('first stool by 48 hours', () => {
  test('silent until 48 h have passed without a stool', () => {
    expect(status({ now: 48 * H }, 'first_stool')).toBe('absent');
    expect(status({ now: 48 * H + 1 }, 'first_stool')).toBe('flag');
  });

  test('a stool at exactly 48 h is in time; one a millisecond later is not', () => {
    expect(status({ now: 50 * H, events: [dirty(48 * H)] }, 'first_stool')).toBe('ok');
    expect(status({ now: 50 * H, events: [dirty(48 * H + 1)] }, 'first_stool')).toBe('flag');
  });

  test('a logged stool is enough on its own; its absence needs the first 48 h logged', () => {
    expect(status({ now: 20 * H, events: [dirty(10 * H)], logged: [] }, 'first_stool')).toBe('ok');
    expect(
      get({ now: 50 * H, events: [dirty(49 * H)], logged: [[24 * H, 50 * H]] }, 'first_stool'),
    ).toMatchObject({ status: 'not_enough_data', reason: 'not_fully_logged' });
  });

  test('stops applying at 72 h', () => {
    expect(status({ now: 72 * H - 1 }, 'first_stool')).toBe('flag');
    expect(status({ now: 72 * H }, 'first_stool')).toBe('absent');
  });
});

describe('black stool and persisting meconium', () => {
  const black = (t: number) => dirty(t, 'black');

  test('black (meconium) stools in the first 4 days are normal', () => {
    expect(status({ now: 96 * H - 1, events: [black(90 * H)] }, 'black_stool')).toBe('absent');
    expect(status({ now: 100 * H, events: [black(96 * H - 1)] }, 'black_stool')).toBe('ok');
  });

  test('a black stool from day 5 (age 4 days) flags under the AAP rule', () => {
    const c = flag({ now: 100 * H, events: [black(96 * H)] }, 'black_stool');
    expect(c.why).not.toMatch(/ABM/);
    expect(cited(c)).toEqual(['stool_black_after_meconium']);
  });

  test("ABM's meconium rule counts stools from exactly 120 h", () => {
    const before = flag({ now: 121 * H, events: [black(120 * H - 1)] }, 'black_stool');
    expect(before.why).not.toMatch(/ABM/);
    expect(cited(before)[0]).toBe('stool_black_after_meconium');
    const at = flag({ now: 121 * H, events: [black(120 * H)] }, 'black_stool');
    expect(at.why).toMatch(/ABM/);
    expect(cited(at)).toEqual(['stool_black_after_meconium', 'meconium_persisting_dol5']);
  });

  test("ABM's meconium rule ends at 168 h", () => {
    const c = flag({ now: 168 * H, events: [black(167 * H)] }, 'black_stool');
    expect(cited(c)).toEqual(['stool_black_after_meconium']);
  });
});

describe('pale and bloody stools (positive evidence over the lookback)', () => {
  const now = 20 * D;

  test('one pale stool means call promptly; two also trip the KidsDoc count', () => {
    const one = flag({ now, events: [dirty(now - D, 'clay')] }, 'pale_stool');
    expect(one.urgency).toBe('promptly');
    expect(cited(one)).toEqual(['stool_pale_white_any', 'stool_pale_white_repeated']);
    const two = flag(
      { now, events: [dirty(now - D, 'white'), dirty(now - 2 * D, 'pale_yellow')] },
      'pale_stool',
    );
    expect(two.observed.value).toBe(2);
    expect(two.evidence).toHaveLength(2);
  });

  test('the 7-day lookback includes its start and nothing before it', () => {
    expect(status({ now, events: [dirty(now - 7 * D, 'white')] }, 'pale_stool')).toBe('flag');
    expect(status({ now, events: [dirty(now - 7 * D - 1, 'white')] }, 'pale_stool')).toBe('ok');
  });

  test('needs no fully-logged mark, and a stool without a colour matches nothing', () => {
    expect(status({ now, logged: [], events: [dirty(now - H, 'white')] }, 'pale_stool')).toBe(
      'flag',
    );
    expect(status({ now, events: [dirty(now - H)] }, 'pale_stool')).toBe('ok');
  });

  test('red colour or the blood flag', () => {
    expect(status({ now, events: [dirty(now - H, 'red')] }, 'blood_in_stool')).toBe('flag');
    expect(
      flag({ now, events: [dirty(now - H, 'yellow', ['blood'])] }, 'blood_in_stool').urgency,
    ).toBe('consider');
    expect(status({ now, events: [dirty(now - H, 'yellow', ['mucus'])] }, 'blood_in_stool')).toBe(
      'ok',
    );
  });
});

describe('weight loss from birth weight', () => {
  const bw = (g = 3000) => weight(2 * H, g);

  test('no birth weight: nothing weighed, or first weigh-in after 24 h', () => {
    expect(get({ now: 3 * D }, 'weight_loss')).toMatchObject({ reason: 'no_birth_weight' });
    expect(
      get({ now: 3 * D, events: [weight(D, 3000), weight(2 * D, 2900)] }, 'weight_loss'),
    ).toMatchObject({ reason: 'no_birth_weight' });
    expect(
      status({ now: 3 * D, events: [weight(D - 1, 3000), weight(2 * D, 2900)] }, 'weight_loss'),
    ).toBe('ok');
  });

  test('only the birth weight so far', () => {
    expect(get({ now: 3 * D, events: [bw()] }, 'weight_loss')).toMatchObject({
      reason: 'no_recent_weight',
    });
  });

  test('NICE/AAP: exactly 10% is not "more than 10%"', () => {
    expect(status({ now: 3 * D, events: [bw(), weight(3 * D - H, 2700)] }, 'weight_loss')).toBe(
      'ok',
    );
    const c = flag({ now: 3 * D, events: [bw(), weight(3 * D - H, 2699)] }, 'weight_loss');
    expect(c.urgency).toBe('consider');
    expect(c.observed.unit).toBe('pct');
    expect(c.observed.value).toBeCloseTo(10.033, 3);
  });

  test('ABM: 8% or more from 120 h, judged at the age of the weigh-in', () => {
    expect(status({ now: 6 * D, events: [bw(), weight(120 * H, 2760)] }, 'weight_loss')).toBe(
      'flag',
    );
    expect(status({ now: 6 * D, events: [bw(), weight(120 * H, 2761)] }, 'weight_loss')).toBe('ok');
    expect(status({ now: 6 * D, events: [bw(), weight(120 * H - 1, 2760)] }, 'weight_loss')).toBe(
      'ok',
    );
  });

  test('stops applying at 21 days', () => {
    expect(status({ now: 21 * D - 1, events: [bw()] }, 'weight_loss')).toBe('not_enough_data');
    expect(status({ now: 21 * D, events: [bw()] }, 'weight_loss')).toBe('absent');
  });
});

describe('still losing weight after day 5', () => {
  const now = 10 * D;

  test('compares weigh-ins at least 2 days apart, both from day 5', () => {
    expect(
      status({ now, events: [weight(5 * D, 3000), weight(7 * D, 3010)] }, 'weight_trend'),
    ).toBe('ok');
    const c = flag({ now, events: [weight(5 * D, 3000), weight(7 * D, 2990)] }, 'weight_trend');
    expect(c.observed).toMatchObject({ value: -5, unit: 'g/day' });
    expect(
      status({ now, events: [weight(5 * D, 3000), weight(7 * D, 3000)] }, 'weight_trend'),
    ).toBe('ok');
  });

  test('not enough data when the weigh-ins are too close or one predates day 5', () => {
    expect(
      get({ now, events: [weight(6 * D, 3000), weight(8 * D - 1, 2990)] }, 'weight_trend'),
    ).toMatchObject({ reason: 'no_recent_weight' });
    expect(
      get({ now, events: [weight(5 * D - 1, 3000), weight(8 * D, 2990)] }, 'weight_trend'),
    ).toMatchObject({ reason: 'no_recent_weight' });
  });

  test('applies on days 5-13 of age', () => {
    expect(status({ now: 5 * D - 1 }, 'weight_trend')).toBe('absent');
    expect(status({ now: 14 * D }, 'weight_trend')).toBe('absent');
  });
});

describe('back to birth weight', () => {
  const bw = weight(2 * H, 3000);

  test('AAP soft flag at 14 days, judged at the age of the latest weigh-in', () => {
    const c = flag({ now: 15 * D, events: [bw, weight(14 * D, 2990)] }, 'birth_weight_regain');
    expect(c.why).toMatch(/AAP/);
    expect(c.observed).toEqual({ value: -10, unit: 'g', expected: { min: 0 } });
    expect(
      get({ now: 15 * D, events: [bw, weight(14 * D - 1, 2990)] }, 'birth_weight_regain'),
    ).toMatchObject({ status: 'not_enough_data', reason: 'no_recent_weight' });
  });

  test('NICE flag at exactly 21 days', () => {
    const c = flag({ now: 22 * D, events: [bw, weight(21 * D, 2990)] }, 'birth_weight_regain');
    expect(c.why).toMatch(/NICE/);
    expect(cited(c)[0]).toBe('regain_birth_weight_nice_days');
  });

  test('once birth weight is regained the flags clear', () => {
    const events = [bw, weight(10 * D, 3000), weight(15 * D, 2990)];
    expect(status({ now: 16 * D, events }, 'birth_weight_regain')).toBe('ok');
  });

  test('needs a birth weight; does not apply before 14 days', () => {
    expect(get({ now: 15 * D }, 'birth_weight_regain')).toMatchObject({
      reason: 'no_birth_weight',
    });
    expect(status({ now: 14 * D - 1, events: [bw] }, 'birth_weight_regain')).toBe('absent');
  });
});

describe('WHO weight gain against the 5th percentile', () => {
  const now = 29 * D;

  test.each([
    ['female', 446],
    ['male', 460],
  ] as const)('%s 0-4 weeks: %i g is the boundary', (sex, p5) => {
    const at = (gain: number) => [weight(H, 3000), weight(28 * D, 3000 + gain)];
    expect(flag({ now, sex, events: at(p5 - 1) }, 'weight_gain').urgency).toBe('consider');
    expect(status({ now, sex, events: at(p5) }, 'weight_gain')).toBe('ok');
  });

  test('evaluated from day 28, once the interval is over', () => {
    expect(status({ now: 28 * D - 1 }, 'weight_gain')).toBe('absent');
    expect(status({ now: 28 * D }, 'weight_gain')).toBe('not_enough_data');
  });

  test('weights must fall within 3 days of each interval end; no interpolation', () => {
    const events = (end: number) => [weight(H, 3000), weight(end, 3500)];
    expect(status({ now: 32 * D, events: events(31 * D) }, 'weight_gain')).toBe('ok');
    expect(get({ now: 32 * D, events: events(31 * D + 1) }, 'weight_gain')).toMatchObject({
      reason: 'no_weight_near_interval_end',
    });
    expect(get({ now, events: [weight(28 * D, 3500)] }, 'weight_gain')).toMatchObject({
      reason: 'no_weight_near_interval_end',
    });
  });

  test('the nearest weight to each end is used', () => {
    const events = [weight(H, 3000), weight(26 * D, 3300), weight(28 * D + H, 3500)];
    expect(status({ now, events }, 'weight_gain')).toBe('ok');
  });

  test('the standards are sex-specific', () => {
    expect(get({ now, sex: 'unspecified' }, 'weight_gain')).toMatchObject({
      reason: 'sex_unknown',
    });
  });
});

describe('feeds per day (first 4 weeks)', () => {
  test('fewer than 8 flags', () => {
    expect(status({ now: after(0), events: inDay(0, 7, breastfeed) }, 'feeds')).toBe('flag');
    expect(status({ now: after(0), events: inDay(0, 8, breastfeed) }, 'feeds')).toBe('ok');
  });

  test('cites the breastfeeding or bottle sources that match the day', () => {
    const bottles = inDay(3, 8, (t) => bottle(t, 40));
    expect(cited(get({ now: after(3), events: bottles }, 'feeds'))).toEqual([
      'bottle_feeds_min_newborn',
    ]);
    expect(cited(get({ now: after(3), events: inDay(3, 8, breastfeed) }, 'feeds'))).toEqual([
      'breastfeeds_min_newborn_cdc',
      'breastfeeds_min_newborn_aap',
    ]);
  });

  test('stops at 4 weeks', () => {
    expect(status({ now: after(27) }, 'feeds')).toBe('flag');
    expect(status({ now: after(28) }, 'feeds')).toBe('absent');
  });
});

describe('formula', () => {
  test('daily ceiling: over 960 mL flags even on a day not marked fully logged', () => {
    const events = inDay(10, 2, (t) => bottle(t, 481));
    expect(status({ now: after(10), events, logged: [] }, 'formula_per_day')).toBe('flag');
  });

  test('daily ceiling: 960 mL is ok only on a fully logged day', () => {
    const events = inDay(10, 2, (t) => bottle(t, 480));
    expect(status({ now: after(10), events }, 'formula_per_day')).toBe('ok');
    expect(get({ now: after(10), events, logged: [] }, 'formula_per_day')).toMatchObject({
      reason: 'not_fully_logged',
    });
  });

  test('breast milk bottles are not formula; no formula means no check', () => {
    const events = inDay(10, 3, (t) => bottle(t, 400, 'breast_milk'));
    expect(status({ now: after(10), events }, 'formula_per_day')).toBe('absent');
  });

  test('first week: a feed over 60 mL flags', () => {
    const big = flag({ now: after(3), events: [bottle(3 * D + H, 61)] }, 'formula_per_feed');
    expect(big.observed.value).toBe(61);
    expect(status({ now: after(3), events: [bottle(3 * D + H, 60)] }, 'formula_per_feed')).toBe(
      'ok',
    );
    expect(status({ now: after(7), events: [bottle(7 * D + H, 90)] }, 'formula_per_feed')).toBe(
      'absent',
    );
  });
});

describe('results', () => {
  test('sorted strictest first: by urgency, then not enough data, then ok', () => {
    const now = after(4);
    const results = run({
      now,
      events: [...inDay(4, 2, wet), dirty(now - H, 'white'), ...inDay(4, 3, (t) => dirty(t))],
      logged: [[4 * D, 5 * D]],
    });
    const ranks = results.map((r) =>
      r.status === 'flag' ? r.urgency : r.status === 'not_enough_data' ? 'ned' : 'ok',
    );
    expect(ranks.slice(0, 2)).toEqual(['now', 'promptly']);
    expect(results[0]!.check).toBe('wet_diapers');
    const firstNed = ranks.indexOf('ned');
    const firstOk = ranks.indexOf('ok');
    expect(firstNed).toBeGreaterThan(1);
    expect(firstOk).toBeGreaterThan(firstNed);
    expect(ranks.slice(firstOk).every((r) => r === 'ok')).toBe(true);
  });

  test('pure: does not mutate its input and gives the same answer twice', () => {
    const events = [wet(30 * H), dirty(20 * H), weight(H, 3000)];
    const copy = JSON.parse(JSON.stringify(events)) as unknown;
    const a = run({ now: 3 * D, events });
    expect(events).toEqual(copy);
    expect(run({ now: 3 * D, events: [...events].reverse() })).toEqual(a);
  });

  test('events after now are ignored', () => {
    expect(status({ now: 30 * H, events: [wet(31 * H)] }, 'no_urine')).toBe('flag');
  });
});
