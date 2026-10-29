import { formatWeight, type BabyEvent } from '@bht/schema';
import { minutes, sideTimes, swatch } from './logic.ts';

// Reports (#21): looking back by day, week and month. Days are cut at the household's
// "Day starts at" time in the phone's time zone, from real wall-clock time, so a day with a
// daylight-saving change is 23 or 25 hours long. This only groups events for display.
// Readings never see it: @bht/insights keeps its day-of-life windows from the birth time.

const HOUR = 3_600_000;

/** A calendar date, months 1–12. */
export interface Ymd {
  y: number;
  m: number;
  d: number;
}

interface Wall extends Ymd {
  h: number;
  min: number;
  /** 0 = Sunday. */
  wd: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function wallFormat(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formats.set(tz, f);
  }
  return f;
}

/** The phone's time zone. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Wall-clock time of an instant in `tz`. Seconds are dropped. */
export function wall(t: number, tz: string): Wall {
  const p: Record<string, string> = {};
  for (const x of wallFormat(tz).formatToParts(t)) p[x.type] = x.value;
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  return {
    y,
    m,
    d,
    h: Number(p.hour) % 24,
    min: Number(p.minute),
    wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
  };
}

/** Local minus UTC at an instant, in ms. */
function offset(t: number, tz: string): number {
  const w = wall(t, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Math.floor(t / 60_000) * 60_000;
}

/** Normalises an out-of-range date, e.g. Oct 32 → Nov 1. */
export function addDays(a: Ymd, n: number): Ymd {
  const u = new Date(Date.UTC(a.y, a.m - 1, a.d + n));
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate() };
}

/**
 * The instant a wall-clock time happens in `tz`. A time that happens twice (clocks go back)
 * gives the first, or the second with `occurrence` 2. A time that never happens (clocks go
 * forward) gives the instant the clocks reach it, an hour later.
 */
export function zoned(date: Ymd, minutes: number, tz: string, occurrence: 1 | 2 = 1): number {
  const { y, m, d } = addDays(date, 0);
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;
  const guess = Date.UTC(y, m - 1, d, h, min);
  const before = offset(guess - 12 * HOUR, tz);
  const found = [...new Set([before, offset(guess + 12 * HOUR, tz)])]
    .map((o) => guess - o)
    .filter((t) => {
      const w = wall(t, tz);
      return w.d === d && w.h === h && w.min === min;
    })
    .sort((a, b) => a - b);
  return found.length ? found[Math.min(occurrence, found.length) - 1]! : guess - before;
}

/** A report day: from one day start to the next. */
export interface DayWindow {
  date: Ymd;
  start: number;
  end: number;
}

/** `dayStart` is minutes after midnight, 0–1439. */
export function dayWindow(date: Ymd, dayStart: number, tz: string): DayWindow {
  return {
    date: addDays(date, 0),
    start: zoned(date, dayStart, tz),
    end: zoned(addDays(date, 1), dayStart, tz),
  };
}

/** Whole hours in a window: 24, or 23 / 25 across a daylight-saving change. */
export const windowHours = (w: DayWindow) => Math.round((w.end - w.start) / HOUR);

/** The report day an instant belongs to. With an 8 AM start, 3 AM Tuesday is Monday. */
export function reportDay(t: number, dayStart: number, tz: string): Ymd {
  const w = wall(t, tz);
  const date: Ymd = { y: w.y, m: w.m, d: w.d };
  return t < dayWindow(date, dayStart, tz).start ? addDays(date, -1) : date;
}

export const sameDay = (a: Ymd, b: Ymd) => a.y === b.y && a.m === b.m && a.d === b.d;
export const compareDay = (a: Ymd, b: Ymd) => a.y - b.y || a.m - b.m || a.d - b.d;
export const weekday = (a: Ymd) => new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
/** The Monday that starts a's week. */
export const mondayOf = (a: Ymd) => addDays(a, -((weekday(a) + 6) % 7));

/** "2026-10-26", for the URL. */
export const ymdKey = (a: Ymd) =>
  `${a.y}-${String(a.m).padStart(2, '0')}-${String(a.d).padStart(2, '0')}`;

export function parseYmd(s: string | null): Ymd | null {
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const a = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return sameDay(addDays(a, 0), a) ? a : null;
}

/** Midnight inside a window (not at its edge), where the "After midnight" divider goes. */
export function midnightIn(w: DayWindow, tz: string): number | null {
  const m = zoned(addDays(w.date, 1), 0, tz);
  return m > w.start && m < w.end ? m : null;
}

/** When the clocks changed inside a window, and which way. Changes happen on the hour. */
export function clockChange(w: DayWindow, tz: string): { at: number; back: boolean } | null {
  const o = offset(w.start, tz);
  for (let t = w.start + HOUR; t < w.end; t += HOUR) {
    const o2 = offset(t, tz);
    if (o2 !== o) return { at: t, back: o2 < o };
  }
  return null;
}

/** True for a time in the repeated hour after clocks go back: the second 1:30 AM. */
export function isSecondOccurrence(t: number, tz: string): boolean {
  const w = wall(t, tz);
  return zoned(w, w.h * 60 + w.min, tz) !== Math.floor(t / 60_000) * 60_000;
}

/** Axis ticks: the day start and every 6 wall-clock hours after it, then the end. */
export function ticks(w: DayWindow, dayStart: number, tz: string): number[] {
  const out = [0, 6, 12, 18].map((k) => {
    const minutes = dayStart + k * 60;
    return zoned(addDays(w.date, Math.floor(minutes / 1440)), minutes % 1440, tz);
  });
  return [...out, w.end];
}

/** Events in [start, end), oldest first. */
export function eventsIn(events: readonly BabyEvent[], start: number, end: number): BabyEvent[] {
  return events
    .filter((e) => {
      const t = Date.parse(e.occurredAt);
      return t >= start && t < end;
    })
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

export interface Tally {
  /** Diaper changes. A mixed diaper counts once here, and as both wet and dirty below. */
  diapers: number;
  wet: number;
  dirty: number;
  breast: number;
  bottle: number;
  bottleMl: number;
  pumps: number;
  /** Weights in the period, oldest first. Weight is not counted anywhere else. */
  weights: Extract<BabyEvent, { type: 'weight' }>[];
}

/** Counts for a period, from the same events the timeline draws. */
export function tally(events: readonly BabyEvent[]): Tally {
  const c: Tally = {
    diapers: 0,
    wet: 0,
    dirty: 0,
    breast: 0,
    bottle: 0,
    bottleMl: 0,
    pumps: 0,
    weights: [],
  };
  for (const e of events) {
    if (e.type === 'diaper') {
      c.diapers += 1;
      if (e.data.kind !== 'dirty') c.wet += 1;
      if (e.data.kind !== 'wet') c.dirty += 1;
    } else if (e.type === 'breastfeed') c.breast += 1;
    else if (e.type === 'bottle') {
      c.bottle += 1;
      c.bottleMl += e.data.volumeMl;
    } else if (e.type === 'pump') c.pumps += 1;
    else if (e.type === 'weight') c.weights.push(e);
  }
  return c;
}

/** A day's place relative to now: finished, under way, or not started. */
export type DayState = 'done' | 'today' | 'future';

export function dayState(w: DayWindow, now: number): DayState {
  if (w.end <= now) return 'done';
  return w.start <= now ? 'today' : 'future';
}

/** Per-day averages over finished days, rounded to one decimal. Null with no finished day. */
export function averages(days: readonly { tally: Tally; state: DayState }[]) {
  const done = days.filter((x) => x.state === 'done');
  if (done.length === 0) return null;
  const per = (k: (t: Tally) => number) =>
    Math.round((done.reduce((s, x) => s + k(x.tally), 0) / done.length) * 10) / 10;
  return {
    days: done.length,
    diapers: per((t) => t.diapers),
    feeds: per((t) => t.breast + t.bottle),
    bottleMl: Math.round(done.reduce((s, x) => s + x.tally.bottleMl, 0) / done.length),
  };
}

// Text ----------------------------------------------------------------------------------

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = zoneFormats.get(key);
  if (!f) zoneFormats.set(key, (f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz })));
  return f;
}
const atNoon = (a: Ymd) => Date.UTC(a.y, a.m - 1, a.d, 12);

/** "1:30 AM", or "1:30 AM (2nd)" in the repeated hour. */
export function clockText(t: number, tz: string): string {
  const s = fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(t);
  return isSecondOccurrence(t, tz) ? `${s} (2nd)` : s;
}

/** "8 AM", for axis ticks and the window subtitle. */
export const hourText = (t: number, tz: string) => fmt(tz, { hour: 'numeric' }).format(t);

/** "Monday, Oct 26". */
export const dayTitle = (a: Ymd) =>
  fmt('UTC', { weekday: 'long', month: 'short', day: 'numeric' }).format(atNoon(a));
/** "Mon 26". */
export const dayShort = (a: Ymd) => `${fmt('UTC', { weekday: 'short' }).format(atNoon(a))} ${a.d}`;
/** "Tue Oct 27". */
export const dayMedium = (a: Ymd) =>
  `${fmt('UTC', { weekday: 'short' }).format(atNoon(a))} ${fmt('UTC', { month: 'short', day: 'numeric' }).format(atNoon(a))}`;
/** "Oct 26 – Nov 1". */
export function weekTitle(monday: Ymd): string {
  const sun = addDays(monday, 6);
  const md = fmt('UTC', { month: 'short', day: 'numeric' });
  return `${md.format(atNoon(monday))} – ${sun.m === monday.m ? sun.d : md.format(atNoon(sun))}`;
}
/** "October 2026". */
export const monthTitle = (a: Ymd) =>
  fmt('UTC', { month: 'long', year: 'numeric' }).format(atNoon(a));

/** "8 AM", "Midnight", "7:30 AM". */
export function dayStartText(minutes: number): string {
  if (minutes === 0) return 'Midnight';
  return fmt('UTC', { hour: 'numeric', minute: minutes % 60 ? '2-digit' : undefined }).format(
    Date.UTC(2026, 0, 1, Math.floor(minutes / 60), minutes % 60),
  );
}

/** "8 AM to 8 AM Tue · 25 h", or "Midnight to midnight". */
export function windowText(w: DayWindow, dayStart: number, tz: string): string {
  const hours = windowHours(w);
  const span =
    dayStart === 0
      ? 'Midnight to midnight'
      : `${hourText(w.start, tz)} to ${hourText(w.end, tz)} ${fmt(tz, { weekday: 'short' }).format(w.end)}`;
  return hours === 24 ? span : `${span} · ${hours} h`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A list row: "Bottle 60 mL" with "Breast milk" under it. Glyph is the dial shape, if any. */
export function rowText(
  e: BabyEvent,
  volume: (ml: number) => string,
): { glyph: 'feed' | 'bottle' | 'wet' | 'dirty' | 'pump' | null; name: string; detail: string } {
  switch (e.type) {
    case 'breastfeed': {
      const d = e.data.durationSeconds;
      if (d === null) return { glyph: 'feed', name: 'Breastfeed', detail: 'Running' };
      const segs = e.data.segments;
      if (segs && segs.length > 1) {
        const t = sideTimes(e, 0)!;
        return {
          glyph: 'feed',
          name: 'Breastfeed',
          detail: `Left ${minutes(t.left / 1000)} · right ${minutes(t.right / 1000)}`,
        };
      }
      return { glyph: 'feed', name: 'Breastfeed', detail: `${cap(e.data.side)} · ${minutes(d)}` };
    }
    case 'bottle':
      return {
        glyph: 'bottle',
        name: `Bottle ${volume(e.data.volumeMl)}`,
        detail: e.data.contents === 'formula' ? 'Formula' : 'Breast milk',
      };
    case 'diaper': {
      if (e.data.kind === 'wet') return { glyph: 'wet', name: 'Wet diaper', detail: '' };
      const st = e.data.stool;
      const detail = [swatch(st?.color)?.label, st?.consistency, st?.size]
        .filter(Boolean)
        .join(' · ');
      return {
        glyph: 'dirty',
        name: e.data.kind === 'mixed' ? 'Mixed diaper' : 'Dirty diaper',
        detail: cap(detail.toLowerCase()),
      };
    }
    case 'pump': {
      const side = (ml: number | null, s: string) => (ml === null ? null : `${s} ${volume(ml)}`);
      return {
        glyph: 'pump',
        name: 'Pump',
        detail: [side(e.data.leftMl, 'L'), side(e.data.rightMl, 'R')].filter(Boolean).join(' · '),
      };
    }
    case 'weight':
      return {
        glyph: null,
        name: `Weight · ${formatWeight(e.data.grams, 'kg')} / ${formatWeight(e.data.grams, 'lb_oz')}`,
        detail: e.data.source === 'clinic' ? 'Clinic' : 'Home scale',
      };
    case 'weighted_feed':
      return { glyph: null, name: 'Weighted feed', detail: '' };
  }
}
