import type { BabyEvent } from '@bht/schema';
import {
  CHECK_LABEL,
  inExpectedRange,
  NONE_LOGGED_CHECKS,
  type CheckId,
  type CheckResult,
  type Interval,
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
  // Every period counts as fully logged unless the parents marked it (#24).
  not_fully_logged: 'You marked missing logs for this day',
  not_synced: 'Not synced, so missing logs could be on the other phone',
  no_birth_weight: 'No weight logged in the first 24 hours',
  no_recent_weight: 'No recent weight logged',
  no_weight_near_interval_end: 'No weight logged near the end of the period',
  sex_unknown: 'Needs the baby’s sex',
  feeding_not_exclusive: 'This rule is for breast milk only, and other feeds were logged',
};

/**
 * Formats an observed number; volumes go through the parent's mL/oz preference. `expected` is
 * the threshold of the entry that decided the result. A strict bound flags itself (an lte /
 * gte entry), so it reads "above" / "below"; otherwise the bound is fine, "at least" / "at most".
 */
export function observedText(o: Observed, volume: (ml: number) => string): string {
  const n = (v: number) => (o.unit === 'mL' ? volume(v) : `${Math.round(v * 10) / 10}`);
  const unit = { count: '', mL: '', g: ' g', 'g/day': ' g/day', pct: '%', h: ' h' }[o.unit];
  const value = `${n(o.value)}${unit}`;
  const { min, max, minStrict, maxStrict } = o.expected;
  const low = min === undefined ? null : `${minStrict ? 'above' : 'at least'} ${n(min)}${unit}`;
  const high = max === undefined ? null : `${maxStrict ? 'below' : 'at most'} ${n(max)}${unit}`;
  const range =
    min !== undefined && max !== undefined && !minStrict && !maxStrict
      ? `${n(min)}–${n(max)}${unit}`
      : low && high
        ? `${low} and ${high}`
        : (low ?? high);
  return range ? `${value} · expected ${range}` : value;
}

/** The short status shown on a check's row. */
export function statusText(r: CheckResult, volume: (ml: number) => string): string {
  if (r.status === 'not_enough_data') {
    return r.reason === 'not_fully_logged' ? 'Not assessed' : 'Not enough data';
  }
  // One sighting is the warning for these, so there is no range to show.
  if (NONE_LOGGED_CHECKS.has(r.check)) {
    return r.status === 'ok' ? 'None logged' : `${r.observed.value} logged`;
  }
  return observedText(r.observed, volume);
}

// --- "We missed some" (#24, owner decision B) ---

/** Checks that count diapers or feeds over a day: a missed log can make them flag. */
export const COUNT_CHECKS: ReadonlySet<CheckId> = new Set(['wet_diapers', 'stools', 'feeds']);

export type MissedLogs = Extract<BabyEvent, { type: 'missed_logs' }>;

/** Live "We missed some" marks. */
export function missedMarks(events: readonly BabyEvent[]): MissedLogs[] {
  return events.filter((e): e is MissedLogs => e.type === 'missed_logs' && !e.deleted);
}

/** Marks that touch this window: the ones "We logged everything" takes back. */
export function marksIn(events: readonly BabyEvent[], w: Interval): MissedLogs[] {
  const [s, e] = [Date.parse(w.start), Date.parse(w.end)];
  return missedMarks(events).filter(
    (m) => Date.parse(m.data.start) < e && s < Date.parse(m.data.end),
  );
}

/**
 * Everything from birth to now counts as fully logged except the marked periods. The risk
 * the owner accepted: a forgotten diaper on an unmarked day can raise a false flag.
 */
export function fullyLogged(
  birthAt: string,
  now: number,
  events: readonly BabyEvent[],
): Interval[] {
  const holes = missedMarks(events)
    .map((m) => [Date.parse(m.data.start), Date.parse(m.data.end)] as const)
    .sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  let from = Date.parse(birthAt);
  for (const [s, e] of holes) {
    if (s > from) out.push({ start: iso(from), end: iso(Math.min(s, now)) });
    from = Math.max(from, e);
    if (from >= now) break;
  }
  if (from < now) out.push({ start: iso(from), end: iso(now) });
  return out.filter((i) => i.start < i.end);
}

const iso = (ms: number) => new Date(ms).toISOString();
