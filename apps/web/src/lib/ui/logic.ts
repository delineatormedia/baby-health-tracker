import {
  fromMl,
  toMl,
  type BabyEvent,
  type Side,
  type StoolColor,
  type VolumeDisplay,
} from '@bht/schema';

// Display logic for the logging screens. Nothing here judges health: readings are #11's job.

export type Breastfeed = Extract<BabyEvent, { type: 'breastfeed' }>;
export type Bottle = Extract<BabyEvent, { type: 'bottle' }>;
export type Diaper = Extract<BabyEvent, { type: 'diaper' }>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Mirrors MAX_FEED_SECONDS in @bht/schema: a longer feed would fail validation. */
export const MAX_FEED_SECONDS = 4 * 60 * 60;

/** The breastfeed whose timer is running (no duration yet), newest first. */
export function runningFeed(events: readonly BabyEvent[]): Breastfeed | undefined {
  return events.find(
    (e): e is Breastfeed => e.type === 'breastfeed' && e.data.durationSeconds === null,
  );
}

/**
 * Seconds to store when a timer stops, at least 1. Null past the schema's 4-hour bound: the
 * timer was probably left running, and the parent has to say how long the feed really was.
 */
export function stopSeconds(startedAt: string, now: number): number | null {
  const s = Math.max(1, Math.round((now - Date.parse(startedAt)) / 1000));
  return s > MAX_FEED_SECONDS ? null : s;
}

/** What to tell the parent when a local write fails. Their input stays on screen. */
export function saveFailure(e: unknown): string {
  const name = e instanceof Error || e instanceof DOMException ? e.name : '';
  if (name === 'QuotaExceededError') return 'Not saved: this phone is out of storage space.';
  return 'Not saved: this phone could not write to its storage.';
}

/** The last finished breastfeed's side, which the next feed usually alternates from. */
export function lastSide(events: readonly BabyEvent[]): Side | null {
  const last = events.find(
    (e): e is Breastfeed => e.type === 'breastfeed' && e.data.durationSeconds !== null,
  );
  return last?.data.side ?? null;
}

export function suggestSide(events: readonly BabyEvent[]): 'left' | 'right' {
  return lastSide(events) === 'left' ? 'right' : 'left';
}

/** Elapsed time as "08:42", or "1:08:42" past an hour. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Hours and minutes, "2:05", for "time since" readouts. */
export function hm(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

/** "just now", "54 min", "3 h 05 min". */
export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Whole days since birth: 0 on the day of birth. */
export function ageDays(birthAt: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(birthAt)) / DAY));
}

export interface Mark {
  /** Hour of the local day, 0–24, for placing the mark on the dial. */
  hour: number;
  kind: 'feed' | 'wet' | 'dirty';
}

/**
 * Dial marks for events in the 24 hours before `now`. A mixed diaper is both wet and dirty,
 * so it adds one mark of each. These are counts of what was logged, not an assessment.
 */
export function dayMarks(events: readonly BabyEvent[], now: number): Mark[] {
  const marks: Mark[] = [];
  for (const e of events) {
    const t = Date.parse(e.occurredAt);
    if (t > now || t <= now - DAY) continue;
    const d = new Date(t);
    const hour = d.getHours() + d.getMinutes() / 60;
    if (e.type === 'breastfeed' || e.type === 'bottle') marks.push({ hour, kind: 'feed' });
    if (e.type === 'diaper') {
      if (e.data.kind !== 'dirty') marks.push({ hour, kind: 'wet' });
      if (e.data.kind !== 'wet') marks.push({ hour, kind: 'dirty' });
    }
  }
  return marks;
}

export function countMarks(marks: readonly Mark[]): Record<Mark['kind'], number> {
  const n = { feed: 0, wet: 0, dirty: 0 };
  for (const m of marks) n[m.kind] += 1;
  return n;
}

/** Point on a dial of radius r around (c, c); hour 0 at the top, clockwise. */
export function polar(hour: number, r: number, c = 150): [number, number] {
  const a = (hour / 24) * 2 * Math.PI - Math.PI / 2;
  return [round2(c + r * Math.cos(a)), round2(c + r * Math.sin(a))];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function lastDiaperAt(events: readonly BabyEvent[]): string | undefined {
  return events.find((e) => e.type === 'diaper')?.occurredAt;
}

/** Recorded bottle volume in the last 24 hours, and how many breastfeeds went unmeasured. */
export function intake24h(events: readonly BabyEvent[], now: number) {
  let bottleMl = 0;
  let unmeasured = 0;
  for (const e of events) {
    const t = Date.parse(e.occurredAt);
    if (t > now || t <= now - DAY) continue;
    if (e.type === 'bottle') bottleMl += e.data.volumeMl;
    if (e.type === 'breastfeed') unmeasured += 1;
  }
  return { bottleMl, unmeasured };
}

// Bottle level ---------------------------------------------------------------------------

/** Top of the bottle scale. The schema allows more; a bigger feed is typed, not dragged. */
export const BOTTLE_MAX_ML = 240;
export const DEFAULT_BOTTLE_ML = 60;

/** Snaps to 5 mL, or to 0.5 oz when the user reads volumes in ounces. */
export function snapBottle(ml: number, display: VolumeDisplay): number {
  const clamped = Math.min(BOTTLE_MAX_ML, Math.max(0, ml));
  if (display === 'oz') return toMl(Math.round(fromMl(clamped, 'oz') * 2) / 2, 'oz');
  return Math.round(clamped / 5) * 5;
}

/** One step up or down the scale, in the same units snapBottle uses. */
export function stepBottle(ml: number, display: VolumeDisplay, dir: 1 | -1): number {
  const step = display === 'oz' ? toMl(0.5, 'oz') : 5;
  return snapBottle(ml + dir * step, display);
}

export function lastBottle(events: readonly BabyEvent[]): Bottle | undefined {
  return events.find((e): e is Bottle => e.type === 'bottle');
}

// Stool swatches --------------------------------------------------------------------------

export interface Swatch {
  color: StoolColor;
  label: string;
  /** Literal paint: swatches never take the theme. */
  hex: string;
  /** Light text on dark paint. */
  dark?: boolean;
}

/** The design board's swatches (docs/design). The colors are fixed in every mode. */
export const NORMAL_SWATCHES: Swatch[] = [
  { color: 'yellow', label: 'Yellow', hex: '#E6C24A' },
  { color: 'mustard', label: 'Mustard', hex: '#C9A227' },
  { color: 'green', label: 'Green', hex: '#6F7F2E' },
  { color: 'brown', label: 'Brown', hex: '#7A5230', dark: true },
  { color: 'black', label: 'Black', hex: '#2A2420', dark: true },
];

/** Grouped under "Consider talking to your pediatrician" (docs/CLINICAL_REFERENCE.md). */
export const FLAG_SWATCHES: Swatch[] = [
  { color: 'pale_yellow', label: 'Pale yellow', hex: '#EFE6B8' },
  { color: 'clay', label: 'Clay', hex: '#BDB3A1' },
  { color: 'white', label: 'White', hex: '#F4F1EA' },
  { color: 'red', label: 'Red', hex: '#9E2A22', dark: true },
];

export function swatch(color: StoolColor | null | undefined): Swatch | undefined {
  return [...NORMAL_SWATCHES, ...FLAG_SWATCHES].find((s) => s.color === color);
}

/** "Wet diaper", "Dirty diaper · mustard", "Breastfeed · left · 14 min". */
export function describe(e: BabyEvent, volume: (ml: number) => string): string {
  switch (e.type) {
    case 'diaper': {
      const name = { wet: 'Wet', dirty: 'Dirty', mixed: 'Mixed' }[e.data.kind];
      const color = e.data.kind === 'wet' ? undefined : swatch(e.data.stool?.color)?.label;
      return `${name} diaper${color ? ` · ${color.toLowerCase()}` : ''}`;
    }
    case 'bottle':
      return `Bottle · ${e.data.contents === 'formula' ? 'formula' : 'breast milk'} · ${volume(e.data.volumeMl)}`;
    case 'breastfeed': {
      const d = e.data.durationSeconds;
      return `Breastfeed · ${e.data.side}${d === null ? ' · running' : ` · ${Math.max(1, Math.round(d / 60))} min`}`;
    }
    case 'pump':
      return 'Pump';
    case 'weight':
      return 'Weight';
    case 'weighted_feed':
      return 'Weighted feed';
  }
}
