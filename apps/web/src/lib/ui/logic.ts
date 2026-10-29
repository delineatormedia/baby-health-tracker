import {
  fromMl,
  segmentsSide,
  toMl,
  type BabyEvent,
  type FeedSegment,
  type Side,
  type StoolColor,
  type VolumeDisplay,
} from '@bht/schema';

// Display logic for the logging screens. Nothing here judges health: readings are #11's job.

export type Breastfeed = Extract<BabyEvent, { type: 'breastfeed' }>;
export type Bottle = Extract<BabyEvent, { type: 'bottle' }>;
export type Diaper = Extract<BabyEvent, { type: 'diaper' }>;
export type Pump = Extract<BabyEvent, { type: 'pump' }>;

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
  return lastFeed(events)?.data.side ?? null;
}

function lastFeed(events: readonly BabyEvent[]): Breastfeed | undefined {
  return events.find(
    (e): e is Breastfeed => e.type === 'breastfeed' && e.data.durationSeconds !== null,
  );
}

/** The other breast from the one the last feed started on. */
export function suggestSide(events: readonly BabyEvent[]): 'left' | 'right' {
  const last = lastFeed(events);
  const started = last?.data.segments?.[0]?.side ?? last?.data.side;
  return started === 'left' ? 'right' : 'left';
}

/**
 * The side a typed duration starts on: the running feed's own side when there is one, so
 * correcting a timer never changes it; otherwise the suggested next side.
 */
export function typedSide(events: readonly BabyEvent[]): Side {
  return runningFeed(events)?.data.side ?? suggestSide(events);
}

type Breast = FeedSegment['side'];

/** A new timer on one breast. */
export function startFeedData(side: Breast): Breastfeed['data'] {
  return { side, durationSeconds: null, segments: [{ side, seconds: null }] };
}

/**
 * An old "both" timer told which breast it is on: the whole feed so far goes to that side.
 * Pause state carries over untouched, so finished pauses stay out of the time and a paused
 * timer stays paused.
 */
export function pickSideData(f: Breastfeed, side: Breast): Breastfeed['data'] {
  return { ...f.data, ...startFeedData(side) };
}

/**
 * A feed's per-side stretches. A feed from before per-side timing has one on its side;
 * a typed or old "both" feed has no known split, so null.
 */
export function feedSegments(f: Breastfeed): FeedSegment[] | null {
  if (f.data.segments) return f.data.segments;
  return f.data.side === 'both' ? null : [{ side: f.data.side, seconds: f.data.durationSeconds }];
}

const closedSeconds = (segs: readonly FeedSegment[]) =>
  segs.reduce((t, s) => t + (s.seconds ?? 0), 0);

/** The breast a running feed is on now, or null for an old "both" timer. */
export function currentSide(f: Breastfeed): Breast | null {
  return feedSegments(f)?.at(-1)?.side ?? null;
}

/** Whether a running feed's timer is paused (#29). */
export const isPaused = (f: Breastfeed) => f.data.pausedAt !== undefined;

const pausedMs = (f: Breastfeed) => (f.data.pausedSeconds ?? 0) * 1000;

/** Where a running feed's clock stands: `now`, or when the current pause began. */
function clockAt(f: Breastfeed, now: number): number {
  return f.data.pausedAt === undefined ? now : Date.parse(f.data.pausedAt);
}

/** Feeding time so far in ms: the start to now (or the pause), less every finished pause. */
export function feedElapsed(f: Breastfeed, now: number): number {
  return Math.max(0, clockAt(f, now) - Date.parse(f.occurredAt) - pausedMs(f));
}

/**
 * When the side being fed now started, on the paused-time-free clock: the feed's start plus
 * every earlier side and every finished pause. Pauses before a switch were already left out
 * of that side's seconds, so they shift this the same way.
 */
export function segmentStart(f: Breastfeed): number {
  return Date.parse(f.occurredAt) + closedSeconds(feedSegments(f) ?? []) * 1000 + pausedMs(f);
}

/** Feeding time on the side being fed now, frozen while paused. */
export function sideElapsed(f: Breastfeed, now: number): number {
  return Math.max(0, clockAt(f, now) - segmentStart(f));
}

/** Milliseconds on each breast so far; the running side counts up to `now`. */
export function sideTimes(f: Breastfeed, now: number): Record<Breast, number> | null {
  const segs = feedSegments(f);
  if (!segs) return null;
  const t = { left: 0, right: 0 };
  const open = sideElapsed(f, now);
  for (const s of segs) t[s.side] += s.seconds === null ? open : s.seconds * 1000;
  return t;
}

/** Pauses a running feed now. Unchanged if it is already paused. */
export function pauseFeedData(f: Breastfeed, now: number): Breastfeed['data'] {
  if (isPaused(f)) return f.data;
  return { ...f.data, pausedAt: new Date(now).toISOString() };
}

/** Same as the schema bound: a pause past it was a forgotten timer. */
export const MAX_PAUSE_SECONDS = 24 * 60 * 60;

/**
 * Resumes a paused feed now: the pause joins pausedSeconds. Null when the total pause passes
 * the schema bound, so the parent types the real duration instead.
 */
export function resumeFeedData(f: Breastfeed, now: number): Breastfeed['data'] | null {
  const { pausedAt, ...data } = f.data;
  if (pausedAt === undefined) return f.data;
  const paused =
    (data.pausedSeconds ?? 0) + Math.max(0, Math.round((now - Date.parse(pausedAt)) / 1000));
  if (paused > MAX_PAUSE_SECONDS) return null;
  return { ...data, pausedSeconds: paused };
}

/**
 * Switch a running feed to the other breast: the side being fed closes at its length so far.
 * Null when there is no side to switch from (an old "both" timer) or the timer has overrun.
 */
export function switchFeedData(f: Breastfeed, now: number): Breastfeed['data'] | null {
  // Switching sides while paused resumes on the new side.
  const resumed = resumeFeedData(f, now);
  if (resumed === null) return null;
  f = { ...f, data: resumed };
  const segs = feedSegments(f);
  const open = segs?.at(-1);
  if (!segs || !open || open.seconds !== null) return null;
  const seconds = Math.round(sideElapsed(f, now) / 1000);
  if (closedSeconds(segs) + seconds > MAX_FEED_SECONDS) return null;
  const next: Breast = open.side === 'left' ? 'right' : 'left';
  const segments = [
    ...segs.slice(0, -1),
    { side: open.side, seconds },
    { side: next, seconds: null },
  ];
  return { ...f.data, side: segmentsSide(segments), durationSeconds: null, segments };
}

/**
 * The finished feed when the timer stops now, or null past the 4-hour bound (see stopSeconds).
 * Paused time is left out; stopping while paused ends the feed when the pause began. The side
 * being fed takes whatever the total leaves after the earlier sides.
 */
export function finishFeedData(f: Breastfeed, now: number): Breastfeed['data'] | null {
  const data = { ...f.data };
  delete data.pausedAt;
  const start = Date.parse(f.occurredAt) + pausedMs(f);
  const total = stopSeconds(new Date(start).toISOString(), clockAt(f, now));
  if (total === null) return null;
  const segs = data.segments;
  if (!segs) return { ...data, durationSeconds: total };
  const closed = closedSeconds(segs.slice(0, -1));
  const last = Math.max(0, total - closed);
  const segments = [...segs.slice(0, -1), { side: segs.at(-1)!.side, seconds: last }];
  return { ...data, side: segmentsSide(segments), durationSeconds: closed + last, segments };
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
  kind: 'feed' | 'bottle' | 'wet' | 'dirty';
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
    if (e.type === 'breastfeed') marks.push({ hour, kind: 'feed' });
    if (e.type === 'bottle') marks.push({ hour, kind: 'bottle' });
    if (e.type === 'diaper') {
      if (e.data.kind !== 'dirty') marks.push({ hour, kind: 'wet' });
      if (e.data.kind !== 'wet') marks.push({ hour, kind: 'dirty' });
    }
  }
  return marks;
}

/**
 * Hours between neighbouring wet/dirty marks on the r=99 ring: 16 units of arc, so even two
 * 11-unit squares turned 45° by the ring (7.8 units corner to centre) never touch.
 */
export const INNER_STEP = (16 / (2 * Math.PI * 99)) * 24;

/**
 * Where to draw the wet and dirty marks on the inner ring. Marks closer than one step (a mixed
 * diaper, or a wet and a dirty logged minutes apart) are spread side by side along the ring,
 * centred on their mean hour, so every logged mark stays visible. Each returned mark keeps its
 * true `hour`; `at` is the drawing position.
 */
export function innerMarks(marks: readonly Mark[]): (Mark & { at: number })[] {
  const inner = marks
    .filter((m) => m.kind === 'wet' || m.kind === 'dirty')
    .toSorted((a, b) => a.hour - b.hour || (a.kind === b.kind ? 0 : a.kind === 'wet' ? -1 : 1));
  if (inner.length === 0) return [];
  type Group = { items: Mark[]; start: number };
  const centre = (items: Mark[]) => items.reduce((s, m) => s + m.hour, 0) / items.length;
  const place = (items: Mark[]): Group => ({
    items,
    start: centre(items) - ((items.length - 1) * INNER_STEP) / 2,
  });
  const end = (g: Group) => g.start + (g.items.length - 1) * INNER_STEP;
  let groups = inner.map((m) => place([m]));
  // Merge neighbours until no two groups crowd each other, including across midnight.
  for (let merged = true; merged && groups.length > 1;) {
    merged = false;
    for (let i = 0; i + 1 < groups.length; i++) {
      const a = groups[i]!;
      const b = groups[i + 1]!;
      if (b.start - end(a) < INNER_STEP - 1e-9) {
        groups.splice(i, 2, place([...a.items, ...b.items]));
        merged = true;
        break;
      }
    }
    if (!merged && groups.length > 1) {
      const first = groups[0]!;
      const last = groups[groups.length - 1]!;
      if (first.start + 24 - end(last) < INNER_STEP - 1e-9) {
        const wrapped = first.items.map((m) => ({ ...m, hour: m.hour + 24 }));
        groups = [...groups.slice(1, -1), place([...last.items, ...wrapped])];
        merged = true;
      }
    }
  }
  return groups.flatMap((g) =>
    g.items.map((m, i) => ({
      kind: m.kind,
      hour: m.hour % 24,
      at: (((g.start + i * INNER_STEP) % 24) + 24) % 24,
    })),
  );
}

/**
 * How far from the dial centre caption text may reach, in dial units: inside the r=99 ring by a
 * dirty square's corner (5.5√2) and a 4-unit gap, so no caption touches a wet or dirty mark.
 */
export const CAPTION_RADIUS = 99 - 5.5 * Math.SQRT2 - 4;

/**
 * Widest a caption row may be, centred, when its top and bottom edges sit `top` and `bottom`
 * (signed, y down) from the centre of a circle of `radius`. The corner farthest from the centre
 * bounds it; a row reaching the circle gets no width.
 */
export function chordWidth(radius: number, top: number, bottom: number): number {
  const far = Math.max(Math.abs(top), Math.abs(bottom));
  return far >= radius ? 0 : 2 * Math.sqrt(radius ** 2 - far ** 2);
}

export function countMarks(marks: readonly Mark[]): Record<Mark['kind'], number> {
  const n = { feed: 0, bottle: 0, wet: 0, dirty: 0 };
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

// Pump ------------------------------------------------------------------------------------

/** A feed that ended this long before a pump started counts as "right after a feed". */
export const AFTER_FEED_MS = 30 * 60_000;

/** The pump whose timer is running (no volumes yet), newest first. */
export function runningPump(events: readonly BabyEvent[]): Pump | undefined {
  return events.find((e): e is Pump => e.type === 'pump' && e.data.durationSeconds === null);
}

/**
 * Stopped, amount not entered (#32): Stop saved the duration at once; the volumes are a later
 * edit. No volume on either side marks it, since a finished pump always has one.
 */
export const awaitingAmount = (p: Pump) =>
  p.data.durationSeconds != null && p.data.leftMl === null && p.data.rightMl === null;

/** The pump stopped with its amount still to enter, newest first. */
export function stoppedPump(events: readonly BabyEvent[]): Pump | undefined {
  return events.find((e): e is Pump => e.type === 'pump' && awaitingAmount(e));
}

/** The last finished pump, for Home and for the next pump's starting volumes. */
export function lastPump(events: readonly BabyEvent[]): Pump | undefined {
  return events.find(
    (e): e is Pump => e.type === 'pump' && e.data.durationSeconds !== null && !awaitingAmount(e),
  );
}

/** The sides a pump ran on: its timer's side, or the sides with a volume on older pumps. */
export function pumpSide(p: Pump): Side {
  if (p.data.side) return p.data.side;
  if (p.data.leftMl !== null && p.data.rightMl !== null) return 'both';
  return p.data.leftMl !== null ? 'left' : 'right';
}

export const pumpsLeft = (side: Side) => side !== 'right';
export const pumpsRight = (side: Side) => side !== 'left';

/** A new timer on these sides. The volumes and "after a feed" are asked at Stop. */
export function startPumpData(side: Side): Pump['data'] {
  return { leftMl: null, rightMl: null, afterFeed: false, side, durationSeconds: null };
}

/** Stop: the timer's sides and duration, saved at once. The volumes come with Log. */
export function stopPumpData(side: Side, durationSeconds: number): Pump['data'] {
  return { leftMl: null, rightMl: null, afterFeed: false, side, durationSeconds };
}

/** A finished pump's data: only the sides it ran on get a volume. */
export function pumpData(
  side: Side,
  volumes: { left: number; right: number },
  afterFeed: boolean,
  durationSeconds?: number,
): Pump['data'] {
  return {
    leftMl: pumpsLeft(side) ? volumes.left : null,
    rightMl: pumpsRight(side) ? volumes.right : null,
    afterFeed,
    side,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

/**
 * Whether a pump starting at `start` directly followed a feed: a finished breastfeed or a
 * bottle ended at most 30 minutes before it. Pre-fills the question; the parent decides.
 */
export function followsFeed(events: readonly BabyEvent[], start: number): boolean {
  return events.some((e) => {
    if (e.deleted) return false;
    let end: number;
    if (e.type === 'bottle') end = Date.parse(e.occurredAt);
    else if (e.type === 'breastfeed' && e.data.durationSeconds !== null)
      end = Date.parse(e.occurredAt) + e.data.durationSeconds * 1000;
    else return false;
    return end <= start && start - end <= AFTER_FEED_MS;
  });
}

/** The volume a side starts at on the Stop screen: that side's last pump, else the default. */
export function lastPumpMl(events: readonly BabyEvent[], breast: 'left' | 'right'): number {
  for (const e of events) {
    if (e.type !== 'pump' || e.data.durationSeconds === null) continue;
    const ml = breast === 'left' ? e.data.leftMl : e.data.rightMl;
    if (ml !== null) return ml;
  }
  return DEFAULT_PUMP_ML;
}

export const DEFAULT_PUMP_ML = 60;

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

/** Whole minutes for a feed, at least 1. */
export const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))} min`;

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
      if (d === null)
        return `Breastfeed · ${currentSide(e) ?? e.data.side} · ${isPaused(e) ? 'paused' : 'running'}`;
      const segs = e.data.segments;
      if (segs && segs.length > 1) {
        // Finished, so no side is open and the clock does not matter.
        const t = sideTimes(e, 0)!;
        return `Breastfeed · left ${minutes(t.left / 1000)} · right ${minutes(t.right / 1000)}`;
      }
      return `Breastfeed · ${e.data.side} · ${minutes(d)}`;
    }
    case 'pump': {
      const side = pumpSide(e);
      if (e.data.durationSeconds === null) return `Pump · ${side} · running`;
      if (awaitingAmount(e))
        return `Pump · ${side} · ${minutes(e.data.durationSeconds!)} · add amount`;
      const parts = [
        e.data.leftMl === null ? null : `left ${volume(e.data.leftMl)}`,
        e.data.rightMl === null ? null : `right ${volume(e.data.rightMl)}`,
      ].filter((p) => p !== null);
      return `Pump · ${parts.join(' · ')}`;
    }
    case 'weight':
      return 'Weight';
    case 'weighted_feed':
      return 'Weighted feed';
    case 'missed_logs':
      return 'Missed logs';
  }
}

/**
 * The second action on an event's Logged toast: the screen that changes its time. Dirty and
 * mixed diapers reopen their details; a running feed opens its timer; the rest share /logged.
 * A "We missed some" mark has no time to change, and a stopped pump is on its amount form, so none.
 */
export type EditPath = `/diaper/details?id=${string}` | '/feed' | '/pump' | `/logged?id=${string}`;

export function editLink(e: BabyEvent): { label: string; path: EditPath } | undefined {
  if (e.type === 'missed_logs') return undefined;
  if (e.type === 'diaper' && e.data.kind !== 'wet')
    return { label: 'Details', path: `/diaper/details?id=${e.id}` };
  if (e.type === 'breastfeed' && e.data.durationSeconds === null)
    return { label: 'Change time', path: '/feed' };
  if (e.type === 'pump' && e.data.durationSeconds === null)
    return { label: 'Change time', path: '/pump' };
  // Its Stop toast sits on the amount form already, so nothing to link to.
  if (e.type === 'pump' && awaitingAmount(e)) return undefined;
  return { label: 'Change time', path: `/logged?id=${e.id}` };
}

/**
 * The latest start a saved event can be moved to: a finished feed or timed pump has to have ended by now,
 * and a running one has to fit the sides it already switched from. Undefined means now.
 */
export function latestStart(e: BabyEvent, now: number): number | undefined {
  if (e.type === 'pump') {
    const d = e.data.durationSeconds;
    return d === undefined || d === null ? undefined : now - d * 1000;
  }
  if (e.type !== 'breastfeed') return undefined;
  // Paused time is part of the feed's span, so it has to fit before now too.
  const paused = pausedMs(e);
  if (e.data.durationSeconds !== null) return now - e.data.durationSeconds * 1000 - paused;
  // A running feed's earlier sides and pauses already happened, so they must fit before its
  // clock: now, or when the current pause began.
  const used = closedSeconds(e.data.segments ?? []) * 1000 + paused;
  return used > 0 || isPaused(e) ? clockAt(e, now) - used : undefined;
}

/**
 * The start to save for an event moved to `at` (null is now), held to its exact latest start.
 * A clamped time stays a timestamp, so a finished feed never ends after `now`.
 */
export function cappedStart(e: BabyEvent, at: string | null, now: number): string {
  const ms = at === null ? now : Date.parse(at);
  const cap = latestStart(e, now);
  return new Date(cap !== undefined && ms > cap ? cap : ms).toISOString();
}
