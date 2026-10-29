import {
  CHECK_LABEL,
  inExpectedRange,
  NONE_LOGGED_CHECKS,
  type CheckResult,
  type NotEnoughDataReason,
  type Observed,
} from '@bht/insights';

/** "In the expected range: wet diapers and weight trend", or null when no check qualifies. */
export function expectedRangeLine(results: readonly CheckResult[]): string | null {
  const names = inExpectedRange(results).map((c) => CHECK_LABEL[c].toLowerCase());
  if (names.length === 0) return null;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `In the expected range: ${list}`;
}

export const REASON_TEXT: Record<NotEnoughDataReason, string> = {
  not_fully_logged: 'The day is not marked fully logged',
  not_synced: 'Not synced, so missing logs could be on the other phone',
  no_birth_weight: 'No weight logged in the first 24 hours',
  no_recent_weight: 'No recent weight logged',
  no_weight_near_interval_end: 'No weight logged near the end of the period',
  sex_unknown: 'Needs the baby’s sex',
  feeding_not_exclusive: 'This rule is for breast milk only, and other feeds were logged',
};

/**
 * Formats an observed number; volumes go through the parent's mL/oz preference. `expected` is
 * the threshold of the entry that decided the result, and the operator is not exposed: a flag
 * whose value sits exactly on its bound came from a gte/lte entry, so that bound is strict
 * ("below 10%"). Everywhere else the inclusive wording is true.
 */
export function observedText(o: Observed, volume: (ml: number) => string, flagged = false): string {
  const n = (v: number) => (o.unit === 'mL' ? volume(v) : `${Math.round(v * 10) / 10}`);
  const unit = { count: '', mL: '', g: ' g', 'g/day': ' g/day', pct: '%', h: ' h' }[o.unit];
  const value = `${n(o.value)}${unit}`;
  const { min, max } = o.expected;
  const atMin = flagged && o.value === min;
  const atMax = flagged && o.value === max;
  const range =
    min !== undefined && max !== undefined
      ? atMin || atMax
        ? `${atMin ? 'above' : 'below'} ${n(atMin ? min : max)}${unit}`
        : `${n(min)}–${n(max)}${unit}`
      : min !== undefined
        ? `${atMin ? 'above' : 'at least'} ${n(min)}${unit}`
        : max !== undefined
          ? `${atMax ? 'below' : 'at most'} ${n(max)}${unit}`
          : null;
  return range ? `${value} · expected ${range}` : value;
}

/** The short status shown on a check's row. */
export function statusText(r: CheckResult, volume: (ml: number) => string): string {
  if (r.status === 'not_enough_data') return 'Not enough data';
  // One sighting is the warning for these, so there is no range to show.
  if (NONE_LOGGED_CHECKS.has(r.check)) {
    return r.status === 'ok' ? 'None logged' : `${r.observed.value} logged`;
  }
  return observedText(r.observed, volume, r.status === 'flag');
}
