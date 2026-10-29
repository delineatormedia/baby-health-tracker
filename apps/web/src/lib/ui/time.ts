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
