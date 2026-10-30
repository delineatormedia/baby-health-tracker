import type { BabyEvent, Id, Sex, Timestamp } from '@bht/schema';

/** How soon to act on a flag, mildest first. */
export const URGENCIES = ['consider', 'within_24h', 'promptly', 'now'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const URGENCY_TEXT: Record<Urgency, string> = {
  consider: 'Consider talking to your pediatrician',
  // AAP KidsDoc triage wording.
  within_24h: 'Contact your pediatrician within 24 hours',
  // Pale, clay or white stool (#11 §2).
  promptly: 'Call your pediatrician promptly',
  // Severe dehydration signs (#11 §9).
  now: 'Seek care now',
};

/** Checks in display order when urgency is equal. */
export const CHECK_IDS = [
  'wet_diapers',
  'no_urine',
  'stools',
  'first_stool',
  'pale_stool',
  'black_stool',
  'blood_in_stool',
  'weight_loss',
  'weight_trend',
  'birth_weight_regain',
  'weight_gain',
  'feeds',
  'formula_per_day',
  'formula_per_feed',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** Short noun phrases. The UI builds "Diapers and weight are in the expected range" from these. */
export const CHECK_LABEL: Record<CheckId, string> = {
  wet_diapers: 'Wet diapers',
  no_urine: 'Time since last wet diaper',
  stools: 'Stools',
  first_stool: 'First stool',
  pale_stool: 'Pale stools',
  black_stool: 'Black stools',
  blood_in_stool: 'Blood in stool',
  weight_loss: 'Weight loss since birth',
  weight_trend: 'Weight trend',
  birth_weight_regain: 'Back to birth weight',
  weight_gain: 'Monthly weight gain',
  feeds: 'Feeds',
  formula_per_day: 'Formula per day',
  formula_per_feed: 'Formula per feed',
};

/**
 * Checks that look for a red-flag stool. Their `ok` means none was logged in the lookback
 * (including stools logged without a colour), not that there was none. Show it as "None
 * logged", and leave these out of the "in the expected range" line.
 */
export const NONE_LOGGED_CHECKS: ReadonlySet<CheckId> = new Set([
  'pale_stool',
  'black_stool',
  'blood_in_stool',
]);

/** The ok checks the "Diapers and weight are in the expected range" line may name. */
export function inExpectedRange(results: readonly CheckResult[]): CheckId[] {
  return results
    .filter((r) => r.status === 'ok' && !NONE_LOGGED_CHECKS.has(r.check))
    .map((r) => r.check);
}

export interface Citation {
  entryId: string;
  organization: string;
  title: string;
  url: string;
  confidence: 'high' | 'moderate' | 'low';
}

export type ObservedUnit = 'count' | 'mL' | 'g' | 'g/day' | 'pct' | 'h';

/**
 * A number to draw on the reading's scale. `expected` is the threshold of the entry that
 * decided the result (the strictest flagging one, or the strictest that could have flagged).
 * `minStrict` / `maxStrict` say the bound itself flags (an lte / gte entry sits on it), so the
 * expected range is "above min" / "below max" rather than "at least" / "at most" (#26).
 */
export interface Observed {
  value: number;
  unit: ObservedUnit;
  expected: { min?: number; max?: number; minStrict?: boolean; maxStrict?: boolean };
}

export type NotEnoughDataReason =
  | 'not_fully_logged'
  | 'not_synced'
  | 'no_birth_weight'
  | 'no_recent_weight'
  | 'no_weight_near_interval_end'
  | 'sex_unknown'
  /** A breastfed-only rule, and some formula was logged. */
  | 'feeding_not_exclusive'
  /** A breastfed-only rule, and no feed was logged in the window, so the feeding is unknown. */
  | 'no_feeds_logged';

export interface Interval {
  start: Timestamp;
  end: Timestamp;
}

/** A check that does not apply at the baby's age is left out of the results, never `ok`. */
export type CheckResult = {
  check: CheckId;
  /** The period the check looked at. */
  window: Interval;
  /** Every entry that applied, strictest first. Low-confidence entries are cited, never flag. */
  citations: Citation[];
} & (
  | { status: 'ok'; observed: Observed }
  | {
      status: 'flag';
      urgency: Urgency;
      title: string;
      why: string;
      observed: Observed;
      /** Event ids behind the flag, for "Edit the diaper". */
      evidence: Id[];
    }
  | {
      status: 'not_enough_data';
      reason: NotEnoughDataReason;
      /** Context only, for example a partial count on a day not marked fully logged. */
      observed?: Observed;
    }
);

/**
 * A stretch of time every other phone of the household has uploaded, or a parent vouched for
 * (step 3b). null is unbounded: the distant past, or no end yet.
 */
export interface SyncedSpan {
  start: Timestamp | null;
  end: Timestamp | null;
}

interface EvaluateBase {
  baby: { birthAt: Timestamp; sex: Sex };
  /** Current versions of this baby's events (after resolveAll). Deleted events are ignored. */
  events: readonly BabyEvent[];
  now: Timestamp;
  /**
   * Periods the parents marked as fully logged. Count and absence checks run only inside them.
   * The mark is the only thing that vouches for writes still offline on the other phone.
   */
  fullyLogged: readonly Interval[];
}

/**
 * Either `synced` or `syncedThrough`. A window is assessable only if one synced span contains
 * all of it: that is the per-window predicate. `syncedThrough` is the single-timestamp case,
 * the one span from the distant past to that time (none when null).
 */
export type EvaluateInput = EvaluateBase &
  (
    | {
        /**
         * The synced spans, on this phone's clock. A removed phone, for example, leaves a gap
         * between its watermark and its removal: windows inside it wait, windows after it do not.
         */
        synced: readonly SyncedSpan[];
        syncedThrough?: never;
      }
    | {
        /**
         * Everything up to this time is synced; null when nothing is. Checks treat it as a lower
         * bound: nothing after it is assumed synced.
         */
        syncedThrough: Timestamp | null;
        synced?: never;
      }
  );
