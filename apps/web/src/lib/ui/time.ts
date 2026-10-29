// <input type="datetime-local"> speaks local wall time without a zone; events store UTC.

/** "2026-10-29T02:59" in the phone's zone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** UTC ISO timestamp for a datetime-local value, or null if it is empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** "2:59 AM" in the phone's locale and zone. */
export function time(iso: string | number): string {
  return timeFormat.format(new Date(iso));
}

const MINUTE = 60_000;
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** Local calendar day number, so "yesterday" follows the phone's midnight and DST. */
function dayNumber(ms: number): number {
  const d = new Date(ms);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
}

/** "2:59 AM" today, "Yesterday 11:40 PM", or "Oct 27, 11:40 PM" for anything older. */
export function when(iso: string | number, now: number): string {
  const ms = new Date(iso).getTime();
  const days = dayNumber(now) - dayNumber(ms);
  if (days === 0) return time(ms);
  if (days === 1) return `Yesterday ${time(ms)}`;
  return `${dateFormat.format(ms)}, ${time(ms)}`;
}

/** The quick backdates offered on every time row, in minutes before now. */
export const QUICK_OFFSETS = [15, 30, 60] as const;

export function minutesBefore(now: number, minutes: number): string {
  return new Date(now - minutes * MINUTE).toISOString();
}

/**
 * Reads a time picked on the phone's wheel. Undefined means the pick can't be used (empty, or
 * later than the cap) and changes nothing, since iOS ignores the input's max and lets a parent
 * spin into the future. Without a cap, anything within the last minute is null, "now". With a
 * cap (a finished feed's latest start) the pick is kept as picked: it is checked against the
 * exact cap and never becomes "now", which would move the feed's end past the present.
 */
export function readPick(value: string, now: number, latest?: number): string | null | undefined {
  const iso = fromLocalInput(value);
  if (iso === null) return undefined;
  const ms = Date.parse(iso);
  if (latest !== undefined) return ms > latest ? undefined : iso;
  if (ms > now) return undefined;
  return ms >= now - MINUTE ? null : iso;
}
