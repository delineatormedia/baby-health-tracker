import * as v from 'valibot';
import { Id, Timestamp } from './model.ts';

// Bounds reject typos (an extra zero), not unusual babies. Insights judge what is normal.
const MAX_FEED_ML = 500;
const MIN_BABY_GRAMS = 300;
const MAX_BABY_GRAMS = 30_000;
const MAX_FEED_SECONDS = 4 * 60 * 60;

const Ml = (min: 'positive' | 'nonnegative') =>
  v.pipe(
    v.number(),
    v.finite(),
    min === 'positive' ? v.gtValue(0) : v.minValue(0),
    v.maxValue(MAX_FEED_ML),
  );
const BabyGrams = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(MIN_BABY_GRAMS),
  v.maxValue(MAX_BABY_GRAMS),
);

export const Side = v.picklist(['left', 'right', 'both']);
export type Side = v.InferOutput<typeof Side>;

export const BreastfeedData = v.strictObject({
  side: Side,
  /** null while the timer is running; occurredAt is the start. */
  durationSeconds: v.nullable(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_FEED_SECONDS)),
  ),
});

export const BottleData = v.strictObject({
  contents: v.picklist(['breast_milk', 'formula']),
  volumeMl: Ml('positive'),
});

/**
 * Stool colors after the infant stool color card used for biliary atresia screening.
 * pale_yellow, clay and white are the acholic (red-flag) colors; black is normal as
 * meconium in the first days; red suggests blood. Which colors flag is decided in insights.
 */
export const StoolColor = v.picklist([
  'black',
  'dark_green',
  'green',
  'yellow',
  'mustard',
  'orange',
  'brown',
  'pale_yellow',
  'clay',
  'white',
  'red',
]);
export type StoolColor = v.InferOutput<typeof StoolColor>;

export const StoolFlag = v.picklist(['blood', 'mucus', 'other']);

/** Every detail is optional so a dirty diaper can still be logged in two taps. */
export const Stool = v.strictObject({
  color: v.nullable(StoolColor),
  consistency: v.nullable(v.picklist(['watery', 'loose', 'seedy', 'pasty', 'formed', 'hard'])),
  size: v.nullable(v.picklist(['small', 'medium', 'large'])),
  flags: v.pipe(
    v.array(StoolFlag),
    v.check((a) => new Set(a).size === a.length, 'Duplicate stool flag'),
  ),
});
export type Stool = v.InferOutput<typeof Stool>;

export const DiaperData = v.variant('kind', [
  v.strictObject({ kind: v.literal('wet') }),
  v.strictObject({ kind: v.picklist(['dirty', 'mixed']), stool: v.nullable(Stool) }),
]);

export const PumpData = v.pipe(
  v.strictObject({
    /** 0 is meaningful: nothing came out (for example right after a feed). null = side not pumped. */
    leftMl: v.nullable(Ml('nonnegative')),
    rightMl: v.nullable(Ml('nonnegative')),
    afterFeed: v.boolean(),
  }),
  v.check(
    (d) => d.leftMl !== null || d.rightMl !== null,
    'Pump needs a volume for at least one side',
  ),
);

export const WeightData = v.strictObject({
  grams: BabyGrams,
  source: v.picklist(['clinic', 'home']),
});

/** Test weighing: weigh, breastfeed, weigh again in the same clothes and diaper. */
export const WeightedFeedData = v.strictObject({
  beforeGrams: BabyGrams,
  afterGrams: BabyGrams,
  side: v.nullable(Side),
});

/**
 * Intake estimate from a weighted feed, using the clinical convention 1 g ≈ 1 mL of milk.
 * Can be negative (the baby voided between weighings); callers decide how to treat that.
 */
export function weightedFeedIntakeMl(data: v.InferOutput<typeof WeightedFeedData>): number {
  return data.afterGrams - data.beforeGrams;
}

/**
 * Fields every event version carries. An edit is a new version with the same id; a delete
 * is a version with deleted = true. recordedAt is the client clock at write time and decides
 * last-writer-wins; the server's sequence number (not part of this schema) breaks ties.
 */
const envelope = {
  id: Id,
  babyId: Id,
  authorId: Id,
  occurredAt: Timestamp,
  recordedAt: Timestamp,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  deleted: v.boolean(),
  notes: v.nullable(v.pipe(v.string(), v.maxLength(2000))),
};

export const BabyEvent = v.variant('type', [
  v.strictObject({ ...envelope, type: v.literal('breastfeed'), data: BreastfeedData }),
  v.strictObject({ ...envelope, type: v.literal('bottle'), data: BottleData }),
  v.strictObject({ ...envelope, type: v.literal('diaper'), data: DiaperData }),
  v.strictObject({ ...envelope, type: v.literal('pump'), data: PumpData }),
  v.strictObject({ ...envelope, type: v.literal('weight'), data: WeightData }),
  v.strictObject({ ...envelope, type: v.literal('weighted_feed'), data: WeightedFeedData }),
]);
export type BabyEvent = v.InferOutput<typeof BabyEvent>;
export type EventType = BabyEvent['type'];
export type EventData<T extends EventType> = Extract<BabyEvent, { type: T }>['data'];

export const EVENT_TYPES = [
  'breastfeed',
  'bottle',
  'diaper',
  'pump',
  'weight',
  'weighted_feed',
] as const satisfies readonly EventType[];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Validates untrusted input (sync payloads, IndexedDB rows) as an event. */
export function parseEvent(input: unknown): ParseResult<BabyEvent> {
  const r = v.safeParse(BabyEvent, input);
  if (r.success) return { ok: true, value: r.output };
  return {
    ok: false,
    errors: r.issues.map((i) => {
      const path = v.getDotPath(i);
      return path ? `${path}: ${i.message}` : i.message;
    }),
  };
}
