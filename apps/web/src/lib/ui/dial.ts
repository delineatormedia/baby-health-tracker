import type { BabyEvent } from '@bht/schema';
import { feedElapsed, polar, type Breastfeed } from './logic.ts';
import { feedEnd } from './reports.ts';

// Home dial geometry and grouping (#51, #52). Tune the dial here: every value the design note
// names is one constant. Lengths are dial units on the 300-unit dial.

/** Taps of one kind within this long of a burst's first tap are one mark with a count. */
export const BURST_MS = 2 * 60_000;
/** The gap in a breastfeed arc where the timer switched sides. */
export const SIDE_GAP = 2;
/** Ring radii, centre to the middle of each ring. */
export const RING = {
  pump: 146,
  outline: 140,
  feed: 134,
  label: 115,
  inner: 99,
} as const;
/** Arc stroke widths. */
export const ARC_WIDTH = { feed: 10, pump: 5 } as const;
/** Background-coloured edge around every arc, so an arc drawn on top shows both its ends. */
export const CASING = 2;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** An arc never closes into a full circle: SVG draws nothing when the ends meet. */
const MAX_SPAN = 23.99;

/** Hours of arc `units` long on a ring of radius `r`. */
export const unitsToHours = (units: number, r: number) => (units / (2 * Math.PI * r)) * 24;

/**
 * Hours between neighbouring wet/dirty marks on the inner ring: 16 units of arc, so even two
 * 11-unit squares turned 45° by the ring (7.8 units corner to centre) never touch.
 */
export const INNER_STEP = unitsToHours(16, RING.inner);
/**
 * Hours between neighbouring labels (burst counts, hour numerals) on the label ring: 28 units,
 * the width of "×3" or "18" at 18.5 units plus a gap.
 */
export const LABEL_STEP = unitsToHours(28, RING.label);

/**
 * Local wall-clock time, in ms from a local-time epoch: what a parent reads off a clock. Every
 * point on the dial (marks, arc ends, side switches, the now line) maps to its angle through
 * this, never as a start plus elapsed time, so a DST change moves nothing off its tick.
 */
const wall = (ms: number) => ms - new Date(ms).getTimezoneOffset() * 60_000;
/** Hour of the day on the dial for a wall-clock time. */
const clock = (w: number) => (((w % DAY) + DAY) % DAY) / HOUR;
const hourOf = (ms: number) => clock(wall(ms));

/** A session on the feed or pump ring. Hours are local hours of day; `to` may pass 24. */
export interface Arc {
  kind: 'feed' | 'pump';
  from: number;
  to: number;
  /** Hours where a breastfeed switched sides, strictly between `from` and `to` (a switch that
   * a fall-back hour puts outside the arc is dropped). */
  switches: number[];
  /** Started more than 24 hours ago: `from` is the cut at the "now" line, drawn flat. */
  cut: boolean;
  /** Sessions with the same start and end (within BURST_MS), drawn as one. */
  count: number;
}

/** A mark logged at one moment. `at` is where it is drawn; it differs from `hour` only when a
 * wet and a dirty sit side by side. */
export interface Point {
  kind: 'bottle' | 'pump' | 'wet' | 'dirty';
  hour: number;
  at: number;
  count: number;
}

/** A burst count on the label ring, and the hour it is drawn at. */
export interface Label {
  at: number;
  text: string;
}

export interface DialFace {
  /** Longest first, so shorter sessions draw on top. */
  arcs: Arc[];
  points: Point[];
  labels: Label[];
  /** Hour numerals (0, 6, 12, 18) shown; a count that would touch one hides it. */
  numerals: number[];
  now: number;
}

/**
 * Groups items sorted by time into bursts: each joins the burst whose first item is within
 * BURST_MS of it. Times are absolute, so a burst across midnight stays one.
 */
export function bursts<T>(items: readonly T[], time: (t: T) => number): T[][] {
  const groups: T[][] = [];
  for (const item of items.toSorted((a, b) => time(a) - time(b))) {
    const g = groups.at(-1);
    if (g && time(item) - time(g[0]!) <= BURST_MS) g.push(item);
    else groups.push([item]);
  }
  return groups;
}

interface Session {
  kind: Arc['kind'];
  start: number;
  end: number;
  /** Absolute times of side switches. */
  switches: number[];
}

/** Where a breastfeed switched sides: each side's share of the feeding time, spread over the
 * whole arc, so pauses (stored only as a total) shift every switch in proportion. */
function feedSwitches(f: Breastfeed, start: number, end: number, now: number): number[] {
  const segs = f.data.segments;
  if (!segs || segs.length < 2) return [];
  const feeding =
    f.data.durationSeconds === null ? feedElapsed(f, now) : f.data.durationSeconds * 1000;
  if (feeding <= 0) return [];
  const scale = (end - start) / feeding;
  const out: number[] = [];
  let done = 0;
  for (const s of segs.slice(0, -1)) {
    done += (s.seconds ?? 0) * 1000;
    const t = start + done * scale;
    if (t > start && t < end) out.push(t);
  }
  return out;
}

function sessions(events: readonly BabyEvent[], now: number): Session[] {
  const out: Session[] = [];
  for (const e of events) {
    const start = Date.parse(e.occurredAt);
    if (start > now) continue;
    if (e.type === 'breastfeed') {
      const end = Math.min(now, feedEnd(e, now));
      out.push({ kind: 'feed', start, end, switches: feedSwitches(e, start, end, now) });
    } else if (e.type === 'pump' && e.data.durationSeconds !== undefined) {
      const d = e.data.durationSeconds;
      const end = d === null ? now : Math.min(now, start + d * 1000);
      out.push({ kind: 'pump', start, end, switches: [] });
    }
  }
  return out.filter((s) => s.end > now - DAY);
}

/**
 * Hours of one session, clipped to the last 24 hours. Both ends are wall-clock hours, so across
 * spring forward the arc sweeps over the skipped hour. Across fall back the end's clock time can
 * be at or before the start's: the arc is then drawn forward from the start at its minimum
 * width, never as a full circle. The 24-hour cut is elapsed time, drawn at its clock time.
 */
function toArc(s: Session, count: number, now: number): Arc {
  const cut = s.start <= now - DAY;
  const at = cut ? now - DAY : s.start;
  const start = wall(at);
  const from = clock(start);
  const r = s.kind === 'feed' ? RING.feed : RING.pump;
  const span = Math.min(
    MAX_SPAN,
    Math.max((wall(s.end) - start) / HOUR, unitsToHours(ARC_WIDTH[s.kind], r)),
  );
  const to = from + span;
  return {
    kind: s.kind,
    from,
    to,
    // Filter on real time first: across fall back a switch before the cut can share a clock
    // hour with the retained part of the arc.
    switches: s.switches
      .filter((t) => t > at)
      .map((t) => from + (wall(t) - start) / HOUR)
      .filter((h) => h > from && h < to),
    cut,
    count,
  };
}

function arcs(events: readonly BabyEvent[], now: number): Arc[] {
  const out: Arc[] = [];
  for (const kind of ['feed', 'pump'] as const) {
    const same = sessions(events, now).filter((s) => s.kind === kind);
    // A burst of sessions that also end together is one arc with a count; the rest overlap.
    for (const g of bursts(same, (s) => s.start)) {
      const left = [...g];
      while (left.length > 0) {
        const first = left[0]!;
        const twins = left.filter((s) => Math.abs(s.end - first.end) <= BURST_MS);
        out.push(toArc(first, twins.length, now));
        for (const t of twins) left.splice(left.indexOf(t), 1);
      }
    }
  }
  return out.toSorted((a, b) => b.to - b.from - (a.to - a.from));
}

/**
 * Spreads items that sit closer than `step` hours apart side by side along the ring, centred on
 * their mean hour, merging neighbours until none crowd each other (midnight included). Returns
 * each item's drawing hour, in input order.
 */
export function spread(hours: readonly number[], step: number): number[] {
  const order = hours.map((h, i) => ({ h, i })).toSorted((a, b) => a.h - b.h);
  if (order.length === 0) return [];
  type Group = { items: { h: number; i: number }[]; start: number };
  const place = (items: Group['items']): Group => ({
    items,
    start: items.reduce((s, m) => s + m.h, 0) / items.length - ((items.length - 1) * step) / 2,
  });
  const end = (g: Group) => g.start + (g.items.length - 1) * step;
  let groups = order.map((m) => place([m]));
  for (let merged = true; merged && groups.length > 1;) {
    merged = false;
    for (let i = 0; i + 1 < groups.length; i++) {
      const a = groups[i]!;
      const b = groups[i + 1]!;
      if (b.start - end(a) < step - 1e-9) {
        groups.splice(i, 2, place([...a.items, ...b.items]));
        merged = true;
        break;
      }
    }
    if (!merged && groups.length > 1) {
      const first = groups[0]!;
      const last = groups[groups.length - 1]!;
      if (first.start + 24 - end(last) < step - 1e-9) {
        const wrapped = first.items.map((m) => ({ ...m, h: m.h + 24 }));
        groups = [...groups.slice(1, -1), place([...last.items, ...wrapped])];
        merged = true;
      }
    }
  }
  const at: number[] = [];
  for (const g of groups)
    g.items.forEach((m, k) => (at[m.i] = (((g.start + k * step) % 24) + 24) % 24));
  return at;
}

/** Circular distance between two hours. */
const apart = (a: number, b: number) => {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
};

/**
 * Where to draw wet and dirty marks. One kind never moves: two wets are drawn at their own
 * times however close. Only a wet and a dirty closer than INNER_STEP (a mixed diaper, or two
 * logs minutes apart) sit side by side, earlier first, centred on their mean hour.
 */
export function placeInner(points: readonly Omit<Point, 'at'>[]): Point[] {
  const order = points
    .map((p, i) => ({ p, i }))
    .toSorted(
      (a, b) => a.p.hour - b.p.hour || (a.p.kind === b.p.kind ? 0 : a.p.kind === 'wet' ? -1 : 1),
    );
  const at = points.map((p) => p.hour);
  const paired = new Set<number>();
  const pair = (a: (typeof order)[number], b: (typeof order)[number], bHour: number) => {
    const mid = (a.p.hour + bHour) / 2;
    at[a.i] = (mid - INNER_STEP / 2 + 24) % 24;
    at[b.i] = (mid + INNER_STEP / 2) % 24;
    paired.add(a.i).add(b.i);
  };
  for (let k = 0; k + 1 < order.length; k++) {
    const a = order[k]!;
    const b = order[k + 1]!;
    if (paired.has(a.i) || paired.has(b.i) || a.p.kind === b.p.kind) continue;
    if (b.p.hour - a.p.hour < INNER_STEP) pair(a, b, b.p.hour);
  }
  // Across midnight: the last mark before it and the first after it.
  const last = order.at(-1);
  const first = order[0];
  if (last && first && last !== first && !paired.has(last.i) && !paired.has(first.i)) {
    if (last.p.kind !== first.p.kind && first.p.hour + 24 - last.p.hour < INNER_STEP) {
      pair(last, first, first.p.hour + 24);
    }
  }
  return points.map((p, i) => ({ ...p, at: at[i]! }));
}

/** Everything drawn on the home dial for the 24 hours before `now`. */
export function dialFace(events: readonly BabyEvent[], now: number): DialFace {
  type Tap = { kind: Point['kind']; t: number };
  const taps: Tap[] = [];
  for (const e of events) {
    const t = Date.parse(e.occurredAt);
    if (t > now || t <= now - DAY) continue;
    if (e.type === 'bottle') taps.push({ kind: 'bottle', t });
    // A pump with a timer is an arc; one logged without a timer is a diamond.
    if (e.type === 'pump' && e.data.durationSeconds === undefined) taps.push({ kind: 'pump', t });
    if (e.type === 'diaper') {
      if (e.data.kind !== 'dirty') taps.push({ kind: 'wet', t });
      if (e.data.kind !== 'wet') taps.push({ kind: 'dirty', t });
    }
  }
  const grouped = (['bottle', 'pump', 'wet', 'dirty'] as const).flatMap((kind) =>
    bursts(
      taps.filter((p) => p.kind === kind),
      (p) => p.t,
    ).map((g) => ({ kind, hour: hourOf(g[0]!.t), count: g.length })),
  );
  const inner = placeInner(grouped.filter((p) => p.kind === 'wet' || p.kind === 'dirty'));
  const points = [
    ...grouped
      .filter((p) => p.kind === 'bottle' || p.kind === 'pump')
      .map((p) => ({ ...p, at: p.hour })),
    ...inner,
  ];
  const face = { arcs: arcs(events, now), points, now: hourOf(now) };

  const counted = [
    ...points.filter((p) => p.count > 1).map((p) => ({ hour: p.at, n: p.count })),
    ...face.arcs.filter((a) => a.count > 1).map((a) => ({ hour: a.from, n: a.count })),
  ];
  // Counts never overlap each other; a numeral they would touch is hidden (its tick stays).
  const at = spread(
    counted.map((c) => c.hour),
    LABEL_STEP,
  );
  const labels = counted.map((c, i) => ({ at: at[i]!, text: `×${c.n}` }));
  const numerals = [0, 6, 12, 18].filter((h) => labels.every((l) => apart(l.at, h) >= LABEL_STEP));
  return { ...face, labels, numerals };
}

/** SVG path for an arc of radius `r` from hour `h0` clockwise to `h1` (h1 ≥ h0). */
export function arcPath(h0: number, h1: number, r: number): string {
  const [x0, y0] = polar(h0, r);
  const [x1, y1] = polar(h1, r);
  return `M${x0} ${y0} A${r} ${r} 0 ${h1 - h0 > 12 ? 1 : 0} 1 ${x1} ${y1}`;
}
