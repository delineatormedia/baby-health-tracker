import * as v from 'valibot';
import { Id, Timestamp } from './model.ts';

// Bounds reject typos (an extra zero), not unusual babies. Insights judge what is normal.
const MAX_FEED_ML = 500;
const MIN_BABY_GRAMS = 300;
const MAX_BABY_GRAMS = 30_000;
const MAX_FEED_SECONDS = 4 * 60 * 60;
/** Paused time on one feed. A longer pause was a forgotten timer, not a burp. */
const MAX_PAUSE_SECONDS = 24 * 60 * 60;

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

/** One stretch on one breast. A switch to the other side starts the next one. */
export const FeedSegment = v.strictObject({
  side: v.picklist(['left', 'right']),
  /** null on the side being fed right now. 0 is a switch straight back. */
  seconds: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_FEED_SECONDS))),
});
export type FeedSegment = v.InferOutput<typeof FeedSegment>;

/** The side a feed's segments add up to: one breast, or both once it switched. */
export function segmentsSide(segments: readonly FeedSegment[]): Side {
  const sides = new Set(segments.map((s) => s.side));
  return sides.size > 1 ? 'both' : (segments[0]?.side ?? 'both');
}

function segmentsAgree(d: {
  side: Side;
  durationSeconds: number | null;
  segments?: FeedSegment[] | undefined;
  // Unread here; listed so the check keeps them in the parsed type.
  pausedSeconds?: number | undefined;
  pausedAt?: string | undefined;
}): boolean {
  const segs = d.segments;
  if (segs === undefined) return true;
  // Valibot still runs this check when a field inside already failed, so stay defensive.
  if (segs.length === 0) return false;
  const last = segs.length - 1;
  // Only the side being fed now is open, and only while the timer runs.
  if (segs.some((s, i) => s.seconds === null && i !== last)) return false;
  if ((segs[last]!.seconds === null) !== (d.durationSeconds === null)) return false;
  if (segs.some((s, i) => i > 0 && s.side === segs[i - 1]!.side)) return false;
  if (segmentsSide(segs) !== d.side) return false;
  const sum = segs.reduce((t, s) => t + (s.seconds ?? 0), 0);
  return d.durationSeconds === null ? sum <= MAX_FEED_SECONDS : sum === d.durationSeconds;
}

export const BreastfeedData = v.pipe(
  v.strictObject({
    side: Side,
    /** null while the timer is running; occurredAt is the start. The total, both sides. */
    durationSeconds: v.nullable(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_FEED_SECONDS)),
    ),
    /**
     * Per-side time in the order fed, from the timer (#19). Absent on typed durations and on
     * feeds logged before per-side timing. Finished, the seconds add up to durationSeconds.
     */
    segments: v.optional(v.pipe(v.array(FeedSegment), v.minLength(1))),
    /**
     * Paused time so far (#29), left out of durationSeconds and the segments. The feed ends
     * at occurredAt + durationSeconds + pausedSeconds. Absent on feeds never paused.
     */
    pausedSeconds: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_PAUSE_SECONDS)),
    ),
    /** Set while the running timer is paused: when the current pause began. */
    pausedAt: v.optional(Timestamp),
  }),
  v.check(
    (d) => d.pausedAt === undefined || d.durationSeconds === null,
    'Only a running feed can be paused',
  ),
  v.check(segmentsAgree, 'Feed segments must alternate sides and add up to the feed'),
);

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

function pumpAgrees(d: {
  leftMl: number | null;
  rightMl: number | null;
  afterFeed: boolean;
  side?: Side | undefined;
  durationSeconds?: number | null | undefined;
}): boolean {
  // Running (#22): occurredAt is the start, and the volumes wait for Stop.
  if (d.durationSeconds === null)
    return d.side !== undefined && d.leftMl === null && d.rightMl === null;
  // Stopped, amount not entered yet (#32): the timer's side and duration, no volumes. Logging the
  // amount is a later edit. A pump logged without a timer always has a volume.
  if (d.leftMl === null && d.rightMl === null)
    return d.side !== undefined && d.durationSeconds !== undefined;
  // The sides pumped are the sides with a volume.
  if (d.side === undefined) return true;
  return d.side === 'both'
    ? d.leftMl !== null && d.rightMl !== null
    : (d.side === 'left') === (d.leftMl !== null) && (d.side === 'right') === (d.rightMl !== null);
}

export const PumpData = v.pipe(
  v.strictObject({
    /** 0 is meaningful: nothing came out (for example right after a feed). null = side not pumped. */
    leftMl: v.nullable(Ml('nonnegative')),
    rightMl: v.nullable(Ml('nonnegative')),
    afterFeed: v.boolean(),
    /** Sides on the pump, from the timer. Absent on pumps logged before the timer (#22). */
    side: v.optional(Side),
    /**
     * null while the timer is running, with no volumes yet; occurredAt is the start.
     * Set with no volumes once the timer stopped and the amount is not entered yet.
     * Absent when the pump was logged without a timer.
     */
    durationSeconds: v.optional(
      v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_FEED_SECONDS))),
    ),
  }),
  v.check(
    pumpAgrees,
    'Pump needs a volume for each side pumped, or none while its timer runs or before its amount is entered',
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
 * "We missed some" (#24): the parents say not every diaper or feed in this period was logged.
 * Every other period counts as fully logged, so count checks skip only what is marked.
 * occurredAt is the start. Deleting the event takes the mark back.
 */
export const MissedLogsData = v.pipe(
  v.strictObject({ start: Timestamp, end: Timestamp }),
  v.check(
    (d) => Date.parse(d.start) < Date.parse(d.end),
    'Missed-logs period must end after it starts',
  ),
);

/**
 * Intake estimate from a weighted feed, using the clinical convention 1 g ≈ 1 mL of milk.
 * Can be negative (the baby voided between weighings); callers decide how to treat that.
 */
export function weightedFeedIntakeMl(data: v.InferOutput<typeof WeightedFeedData>): number {
  return data.afterGrams - data.beforeGrams;
}

/** Safe integers only: past 2^53 - 1, version + 1 === version and edits stop being ordered. */
const EventVersion = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/** The version for the next edit or delete of an event. Throws if versions are exhausted. */
export function nextVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Cannot increment event version ${version}`);
  }
  return version + 1;
}

/**
 * Fields every event version carries. An edit is a new version with the same id; a delete
 * is a version with deleted = true. recordedAt is the client clock at write time, kept for
 * the record only: the highest version wins and the server's sequence number (not part of
 * this schema) breaks ties, so a skewed clock never decides a conflict (compareVersions).
 */
const envelope = {
  id: Id,
  babyId: Id,
  authorId: Id,
  occurredAt: Timestamp,
  recordedAt: Timestamp,
  version: EventVersion,
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
  v.strictObject({ ...envelope, type: v.literal('missed_logs'), data: MissedLogsData }),
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
  'missed_logs',
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
