import { gramsToLbOz, type BabyEvent } from '@bht/schema';
import { awaitingAmount, currentSide, minutes, pumpSide, sideTimes, swatch } from './logic.ts';

// History (#35): the log by day, newest first. History is where a parent edits; Reports only look.

export type HistoryEvent = Exclude<BabyEvent, { type: 'missed_logs' }>;

export interface HistoryDay {
  /** Day start and the next day start, ms. */
  start: number;
  end: number;
  /** "Today", "Yesterday" or "Mon, Oct 26". */
  label: string;
  /** Newest first. */
  events: HistoryEvent[];
}

/** The day start on or before `t`, in the phone's zone. `dayStart` is minutes after midnight. */
export function dayStartBefore(t: number, dayStart: number): number {
  const d = new Date(t);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, dayStart).getTime();
  if (today <= t) return today;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 0, dayStart).getTime();
}

/** The next day start after the one at `start`; 23 or 25 hours across a clock change. */
export function nextDayStart(start: number, dayStart: number): number {
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, dayStart).getTime();
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/**
 * Logged events grouped into days from "Day starts at" (#21), newest day first. "We missed
 * some" marks are not logs, so they never show as rows; each day carries its own mark instead.
 */
export function historyDays(
  events: readonly BabyEvent[],
  dayStart: number,
  now: number,
): HistoryDay[] {
  const today = dayStartBefore(now, dayStart);
  const yesterday = dayStartBefore(today - 1, dayStart);
  const days = new Map<number, HistoryDay>();
  for (const e of events) {
    if (e.deleted || e.type === 'missed_logs') continue;
    const start = dayStartBefore(Date.parse(e.occurredAt), dayStart);
    let day = days.get(start);
    if (!day) {
      const label =
        start === today ? 'Today' : start === yesterday ? 'Yesterday' : dayFormat.format(start);
      day = { start, end: nextDayStart(start, dayStart), label, events: [] };
      days.set(start, day);
    }
    day.events.push(e);
  }
  const byTime = (a: HistoryEvent, b: HistoryEvent) =>
    Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
  return [...days.values()]
    .sort((a, b) => b.start - a.start)
    .map((d) => ({ ...d, events: d.events.sort(byTime) }));
}

/** The shape drawn beside a row, from the dial's key (docs/design). Weight has none. */
export type Glyph = 'feed' | 'bottle' | 'wet' | 'dirty' | 'pump' | null;

export function glyph(e: HistoryEvent): Glyph {
  switch (e.type) {
    case 'breastfeed':
    case 'weighted_feed':
      return 'feed';
    case 'bottle':
      return 'bottle';
    case 'diaper':
      return e.data.kind === 'wet' ? 'wet' : 'dirty';
    case 'pump':
      return 'pump';
    case 'weight':
      return null;
  }
}

/** "3 610 g", grouped with a narrow no-break space as on the board. */
export function grams(g: number): string {
  return `${String(Math.round(g)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} g`;
}

/** "7 lb 15.3 oz". */
export function lbOz(g: number): string {
  const { lb, oz } = gramsToLbOz(g);
  return `${lb} lb ${oz} oz`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A row's title and its caption line: "Breastfeed" over "Left 8 min · Right 6 min".
 * The caption is null when the title says it all ("Wet diaper").
 */
export function rowText(
  e: HistoryEvent,
  volume: (ml: number) => string,
): { title: string; caption: string | null } {
  switch (e.type) {
    case 'diaper': {
      const title = `${cap(e.data.kind)} diaper`;
      if (e.data.kind === 'wet') return { title, caption: null };
      const s = e.data.stool;
      const parts = [
        swatch(s?.color)?.label,
        s?.consistency ?? undefined,
        s?.size ?? undefined,
        ...(s?.flags ?? []),
      ].filter((p): p is string => p !== undefined);
      return { title, caption: parts.length ? parts.join(' · ') : null };
    }
    case 'breastfeed': {
      const d = e.data.durationSeconds;
      if (d === null) {
        return { title: 'Breastfeed', caption: `${cap(currentSide(e) ?? e.data.side)} · running` };
      }
      const segs = e.data.segments;
      if (segs && segs.length > 1) {
        const t = sideTimes(e, 0)!;
        return {
          title: 'Breastfeed',
          caption: `Left ${minutes(t.left / 1000)} · Right ${minutes(t.right / 1000)}`,
        };
      }
      return { title: 'Breastfeed', caption: `${cap(e.data.side)} · ${minutes(d)}` };
    }
    case 'bottle':
      return {
        title: 'Bottle',
        caption: `${e.data.contents === 'formula' ? 'Formula' : 'Breast milk'} · ${volume(e.data.volumeMl)}`,
      };
    case 'pump': {
      // A pump timer (#32) is running, or stopped with its amount still to enter.
      if (e.data.durationSeconds === null) {
        return { title: 'Pump', caption: `${cap(pumpSide(e))} · running` };
      }
      const d = e.data.durationSeconds;
      if (d != null && awaitingAmount(e)) {
        return { title: 'Pump', caption: `${minutes(d)} · add amount` };
      }
      const parts = [
        e.data.leftMl === null ? undefined : `${volume(e.data.leftMl)} L`,
        e.data.rightMl === null ? undefined : `${volume(e.data.rightMl)} R`,
        e.data.afterFeed ? 'after feed' : undefined,
      ].filter((p): p is string => p !== undefined);
      return { title: 'Pump', caption: parts.join(' · ') };
    }
    case 'weight':
      return {
        title: 'Weight',
        caption: `${e.data.source === 'clinic' ? 'Clinic' : 'Home scale'} · ${grams(e.data.grams)} · ${lbOz(e.data.grams)}`,
      };
    case 'weighted_feed':
      return {
        title: 'Weighted feed',
        caption: `${grams(e.data.beforeGrams)} → ${grams(e.data.afterGrams)}`,
      };
  }
}

/**
 * Where a row opens: a running feed is its timer, a running pump or one waiting on its amount
 * is the pump screen; everything else is the History editor.
 */
export function entryPath(e: HistoryEvent): '/feed' | '/pump' | `/history/entry?id=${string}` {
  if (e.type === 'breastfeed' && e.data.durationSeconds === null) return '/feed';
  if (e.type === 'pump' && (e.data.durationSeconds === null || awaitingAmount(e))) return '/pump';
  return `/history/entry?id=${e.id}`;
}
