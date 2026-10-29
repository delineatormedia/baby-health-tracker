import type { Baby, BabyEvent, EventData, EventType, Stool } from '@bht/schema';
import type { CheckId } from '@bht/insights';
import type { EditFields } from '../data/store.ts';
import {
  finishFeedData,
  pauseFeedData,
  pumpData,
  resumeFeedData,
  startFeedData,
  startPumpData,
  stopPumpData,
  switchFeedData,
} from '../ui/logic.ts';

// Dev-only fake data (#58). Nothing here is real: the baby is made up, and every number is
// generated from a fixed seed relative to "now", so a scenario looks the same on every load.

export const SCENARIOS = ['empty', 'healthy-month', 'incidents-month'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export const isScenario = (s: unknown): s is ScenarioName => SCENARIOS.some((name) => name === s);

/** An incident the incidents-month scenario plants, and the insight it should raise. */
export interface Incident {
  /** Day of life, 1-based, as Readings shows it. */
  day: number;
  check: CheckId;
  what: string;
  /** Still flagged on Readings when the scenario loads. */
  showsNow: boolean;
}

/**
 * Writes go through this, in the order a parent would make them. `at` sets the clock the next
 * write is recorded at, and which parent's phone makes it.
 */
export interface Writer {
  at(ms: number, parent?: 0 | 1): void;
  log<T extends EventType>(type: T, data: EventData<T>, occurredAt?: number): Promise<BabyEvent>;
  edit(id: string, fields: EditFields): Promise<BabyEvent>;
  remove(id: string): Promise<void>;
}

export interface Scenario {
  baby: Baby | null;
  /** When the phone set the baby up (ms). */
  setupAt: number | null;
  incidents: Incident[];
  write: (w: Writer) => Promise<void>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Days of life before today's: about a month of use. */
const DAYS = 30;
const BIRTH_GRAMS = 3420;

type Breastfeed = Extract<BabyEvent, { type: 'breastfeed' }>;

/** Small seeded PRNG (mulberry32): the same seed gives the same month. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

/** Day-of-life overrides; the healthy month has none. */
interface Plan {
  wets?: Record<number, number>;
  feeds?: Record<number, number>;
  stool?: Record<number, Partial<Stool>>;
  weights: Record<number, number>;
}

const HEALTHY: Plan = {
  // Down about 6.5% by day 3, back to birth weight by day 10, then about 32 g a day.
  weights: weightCurve([0, 2, 4, 7, 10, 14, 21, 28], (d) =>
    d <= 3
      ? BIRTH_GRAMS * (1 - 0.022 * d)
      : d <= 10
        ? BIRTH_GRAMS * (0.934 + (0.066 * (d - 3)) / 7)
        : BIRTH_GRAMS + 32 * (d - 10),
  ),
};

/** Incidents relative to the last completed day, so the recent ones show on Readings now. */
function incidentsPlan(last: number): { plan: Plan; incidents: Incident[] } {
  const d = (n: number) => last - n;
  const gain = (day: number) => 3440 + 30 * (day - 18);
  const plan: Plan = {
    // More than 10% lost by day 4, losing again around day 10, birth weight only by day 18.
    weights: {
      0: BIRTH_GRAMS,
      2: 3200,
      3: 3030,
      5: 3080,
      7: 3160,
      10: 3110,
      13: 3250,
      15: 3350,
      18: gain(18),
      21: gain(21),
      28: gain(28),
    },
    feeds: { [d(12)]: 5 },
    wets: { [last]: 3 },
    stool: {
      [d(9)]: { flags: ['blood'] },
      [d(3)]: { color: 'pale_yellow', consistency: 'pasty' },
    },
  };
  const loss = (((BIRTH_GRAMS - 3030) / BIRTH_GRAMS) * 100).toFixed(1);
  const incidents: Incident[] = [
    {
      day: 4,
      check: 'weight_loss',
      what: `3030 g at the day-4 weigh-in, ${loss}% below birth weight`,
      showsNow: false,
    },
    {
      day: 11,
      check: 'weight_trend',
      what: '3110 g on day 11, down from 3160 g on day 8',
      showsNow: false,
    },
    {
      day: 16,
      check: 'birth_weight_regain',
      what: '3350 g at day 16, still below the 3420 g birth weight',
      showsNow: false,
    },
    { day: d(12) + 1, check: 'feeds', what: 'Only 5 feeds that day', showsNow: false },
    { day: d(9) + 1, check: 'blood_in_stool', what: 'A stool logged with blood', showsNow: false },
    {
      day: d(3) + 1,
      check: 'pale_stool',
      what: 'A pale yellow stool (flagged for 7 days)',
      showsNow: true,
    },
    {
      day: 29,
      check: 'weight_gain',
      what: `${gain(28) - BIRTH_GRAMS} g gained over weeks 0-4, after the slow start`,
      showsNow: true,
    },
    {
      day: last + 1,
      check: 'wet_diapers',
      what: 'Only 3 wet diapers on the last full day',
      showsNow: true,
    },
  ];
  return { plan, incidents };
}

function weightCurve(days: number[], grams: (d: number) => number): Record<number, number> {
  return Object.fromEntries(days.map((d) => [d, Math.round(grams(d))]));
}

/** Local midnight `days` before `now`'s day, plus `ms`. */
function localDay(now: number, days: number, ms: number): number {
  const t = new Date(now);
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() - days);
  return t.getTime() + ms;
}

export function scenario(name: ScenarioName, now: number): Scenario {
  if (name === 'empty') return { baby: null, setupAt: null, incidents: [], write: async () => {} };
  const birth = localDay(now, DAYS, 5 * HOUR + 17 * MIN);
  const last = Math.floor((now - birth) / DAY) - 1;
  const { plan, incidents } =
    name === 'healthy-month' ? { plan: HEALTHY, incidents: [] } : incidentsPlan(last);
  const baby: Baby = {
    // Fixed ids keep a reload of the same scenario under the same baby.
    id: name === 'healthy-month' ? '01JTESTBABYHEA1THYM0NTH000' : '01JTESTBABY1NC1DENTSM0NTH0',
    householdId: '01JTESTH0VSEH01D0000000000',
    name: 'Pip Testbaby',
    birthAt: new Date(birth).toISOString(),
    sex: 'female',
  };
  return {
    baby,
    setupAt: birth + 2 * HOUR,
    incidents,
    write: (w) => month(w, { birth, now, last, plan, r: rng(name === 'healthy-month' ? 58 : 59) }),
  };
}

interface Ctx {
  birth: number;
  now: number;
  /** Index of the last completed day of life. */
  last: number;
  plan: Plan;
  r: Rng;
}

/** Healthy counts by day of life: at or a little over the CDC/ABM minimums, then 7-9 wets. */
const healthyWets = (d: number, r: Rng) =>
  d === 0 ? r.int(2, 3) : d === 1 ? 4 : d < 4 ? d + 3 + r.int(0, 1) : r.int(7, 9);
const healthyStools = (d: number, r: Rng) =>
  d === 0 ? r.int(1, 2) : d === 3 ? r.int(4, 5) : r.int(3, 5);

async function month(w: Writer, c: Ctx): Promise<void> {
  const { birth, now, r } = c;
  // The newest feed is still running, on its second side.
  const running = now - 14 * MIN;
  for (let d = 0; d <= c.last + 1; d++) {
    const from = birth + d * DAY;
    const to = Math.min(from + DAY, now);
    if (from >= now) break;
    const grams = c.plan.weights[d];
    if (grams !== undefined) await weigh(w, c, d, from, grams);
    const nFeeds = c.plan.feeds?.[d] ?? (d === 0 ? 8 : r.int(9, 11));
    const slot = DAY / nFeeds;
    for (let i = 0; i < nFeeds; i++) {
      const start = from + i * slot + r.int(5, Math.round((slot * 0.3) / MIN)) * MIN;
      if (start > running - 2 * HOUR) break;
      // From week 2 the other parent gives one breast-milk bottle a day; a little formula
      // on two days in week 3 and 4.
      if (d >= 7 && i === nFeeds - 3) {
        const formula = d === 16 || d === 23;
        await bottle(w, start, formula ? 'formula' : 'breast_milk', formula ? 90 : 60 + 2 * d, r);
      } else {
        await breastfeed(w, start, r);
      }
    }
    if (d >= 10 && from + 9 * HOUR < now - HOUR) await pump(w, from + 9 * HOUR, d, r);
    await diapers(w, c, d, from, to);
  }
  await runningFeed(w, running);
}

async function weigh(w: Writer, c: Ctx, d: number, from: number, grams: number) {
  const clinic = d === 0 || d === 2 || d === 4 || d === 7 || d === 14 || d === 28;
  const t = from + (d === 0 ? HOUR : 10 * HOUR + 30 * MIN);
  if (t > c.now) return;
  // Clinic weights are typed in that evening; home weights are logged on the spot.
  w.at(clinic && d > 0 ? t + 8 * HOUR : t + MIN, 0);
  await w.log('weight', { grams, source: clinic ? 'clinic' : 'home' }, t);
  // One test weighing at the first-week visit.
  if (d === 7) {
    w.at(t + 9 * HOUR, 0);
    await w.log('weighted_feed', { beforeGrams: grams, afterGrams: grams + 62, side: 'both' }, t);
  }
}

/** A breastfeed on the timer: start, maybe a pause, switch, stop. */
async function breastfeed(w: Writer, start: number, r: Rng) {
  const first = r.chance(0.5) ? 'left' : 'right';
  w.at(start, 0);
  let f = (await w.log('breastfeed', startFeedData(first))) as Breastfeed;
  let t = start + r.int(7, 15) * MIN;
  if (r.chance(0.1)) {
    w.at(t);
    f = (await w.edit(f.id, { data: pauseFeedData(f, t) })) as Breastfeed;
    t += r.int(2, 5) * MIN;
    w.at(t);
    f = (await w.edit(f.id, { data: resumeFeedData(f, t)! })) as Breastfeed;
    t += r.int(1, 4) * MIN;
  }
  if (r.chance(0.85)) {
    w.at(t);
    f = (await w.edit(f.id, { data: switchFeedData(f, t)! })) as Breastfeed;
    t += r.int(5, 14) * MIN;
  }
  w.at(t);
  await w.edit(f.id, { data: finishFeedData(f, t)! });
}

async function runningFeed(w: Writer, start: number) {
  w.at(start, 0);
  const f = (await w.log('breastfeed', startFeedData('left'))) as Breastfeed;
  const t = start + 10 * MIN;
  w.at(t);
  await w.edit(f.id, { data: switchFeedData(f, t)! });
}

async function bottle(
  w: Writer,
  t: number,
  contents: 'breast_milk' | 'formula',
  volumeMl: number,
  r: Rng,
) {
  w.at(t + 15 * MIN, 1);
  const b = await w.log('bottle', { contents, volumeMl: Math.min(volumeMl, 120) }, t);
  // Now and then the amount is corrected afterwards.
  if (r.chance(0.15)) {
    w.at(t + 17 * MIN, 1);
    await w.edit(b.id, { data: { contents, volumeMl: Math.min(volumeMl, 120) - 10 } });
  }
}

/** Pump on the timer, then the amount: both sides most days. */
async function pump(w: Writer, start: number, d: number, r: Rng) {
  const side = r.chance(0.8) ? 'both' : r.chance(0.5) ? 'left' : 'right';
  const secs = r.int(12, 20) * 60;
  w.at(start, 0);
  const p = await w.log('pump', startPumpData(side));
  w.at(start + secs * 1000);
  await w.edit(p.id, { data: stopPumpData(side, secs) });
  w.at(start + secs * 1000 + MIN);
  const ml = () => Math.min(40 + d + r.int(0, 30), 160);
  await w.edit(p.id, { data: pumpData(side, { left: ml(), right: ml() }, false, secs) });
}

async function diapers(w: Writer, c: Ctx, d: number, from: number, to: number) {
  const { r } = c;
  const wets = c.plan.wets?.[d] ?? healthyWets(d, r);
  const stools = healthyStools(d, r);
  const mixed = Math.min(wets, stools, r.int(0, 2));
  // Each kind spread evenly through the day, so wet diapers never leave a long gap.
  const times = (n: number) => Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * DAY);
  const planned = [
    ...times(wets - mixed).map((t) => ({ t, kind: 'wet' as const })),
    ...times(stools - mixed).map((t) => ({ t, kind: 'dirty' as const })),
    ...times(mixed).map((t) => ({ t: t + 40 * MIN, kind: 'mixed' as const })),
  ]
    .map((p) => ({ ...p, t: from + p.t + r.int(-30, 30) * MIN }))
    .sort((a, b) => a.t - b.t);
  const special = c.plan.stool?.[d];
  let specialDone = false;
  let i = 0;
  for (const { t, kind } of planned) {
    if (t >= to) break;
    // Night changes are often logged the next morning (backdated).
    const hour = new Date(t).getHours();
    const late = hour < 6 && r.chance(0.3) ? r.int(60, 240) * MIN : r.int(0, 2) * MIN;
    w.at(t + late, r.chance(0.6) ? 0 : 1);
    if (kind === 'wet') {
      const e = await w.log('diaper', { kind }, t);
      // A few days have a burst of repeat taps on the day's first wet diaper.
      if (i === 0 && (d === 6 || d === 13 || d === 20) && t + MIN < to) {
        for (const s of [20, 45]) {
          w.at(t + s * 1000);
          await w.log('diaper', { kind }, t + s * 1000);
        }
      }
      // An accidental tap, undone.
      if (i === 1 && d % 9 === 5) {
        w.at(t + 10_000);
        await w.remove(e.id);
        w.at(t + 30_000);
        await w.log('diaper', { kind }, t + 30_000);
      }
      i++;
      continue;
    }
    let stool: Stool | null = r.chance(0.3) ? null : stoolFor(d, r);
    if (special && !specialDone) {
      stool = { ...stoolFor(d, r), ...special };
      specialDone = true;
    }
    const e = await w.log('diaper', { kind, stool: null }, t);
    // Details are added on the details screen right after logging.
    if (stool) {
      w.at(t + late + 40_000);
      await w.edit(e.id, { data: { kind, stool } });
    }
  }
}

function stoolFor(d: number, r: Rng): Stool {
  const color =
    d < 2
      ? 'black'
      : d < 3
        ? 'dark_green'
        : d < 4
          ? 'green'
          : (['yellow', 'mustard', 'yellow', 'orange'] as const)[r.int(0, 3)]!;
  return {
    color,
    consistency: d < 3 ? 'pasty' : r.chance(0.7) ? 'seedy' : 'loose',
    size: (['small', 'medium', 'large'] as const)[r.int(0, 2)]!,
    flags: [],
  };
}
