// Home quick-log keys (#20, docs/design/README.md "Home quick-log keys"). Every line is read
// from the current event list, so a log or an Undo changes it straight away.

import type { BabyEvent, Side } from '@bht/schema';
import { lastPump, pumpSide, type Breastfeed } from './logic.ts';
import { time } from './time.ts';

export type KeyKind = 'feed' | 'wet' | 'dirty' | 'bottle' | 'pump';

/** One line under a key's label: `em` in ink, `rest` in the dim text colour. */
export interface KeyLine {
  em: string;
  rest: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** "Just now" under a minute, "54m ago", "3h 10m ago", then the date ("Oct 27") past 24 h. */
export function since(at: number, now: number): KeyLine {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return { em: 'Just now', rest: '' };
  if (ms >= DAY) return { em: dateFormat.format(at), rest: '' };
  const min = Math.floor(ms / MINUTE);
  const h = Math.floor(min / 60);
  return { em: h > 0 ? `${h}h ${min % 60}m` : `${min}m`, rest: ' ago' };
}

/** Full words for the Home dial (#82): "3 hours 10 minutes ago", singular forms ("1 hour 1
 * minute ago"), "1 day 2 hours ago" past a day, "Just now" under a minute. */
export function sinceWords(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return 'Just now';
  const min = Math.floor(ms / MINUTE);
  const days = Math.floor(min / (24 * 60));
  const hours = Math.floor((min % (24 * 60)) / 60);
  const minutes = min % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  // Past a day the minutes drop off; "2 days 1 hour ago" is the finest a day-old feed reads.
  if (days === 0 && minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return `${parts.join(' ')} ago`;
}

const SIDE: Record<Side, string> = { left: 'Left', right: 'Right', both: 'Both' };

export function sideLine(side: Side): KeyLine {
  return { em: SIDE[side], rest: side === 'both' ? ' sides' : ' side' };
}

const NOT_YET: KeyLine[] = [{ em: '', rest: 'Not logged yet' }];

/**
 * The lines under each key. Feed's side is the last breastfeed's side, "Both" once it switched,
 * as on the feed screen. A running breastfeed or pump is not "last logged": its key shows the
 * timer instead, so its lines come from the last finished one. A pump stopped with its amount
 * still to enter is not finished either (the Pump key asks for the amount).
 */
export function keyLines(
  events: readonly BabyEvent[],
  now: number,
  volume: (ml: number) => string,
): Record<KeyKind, KeyLine[]> {
  const at = (e: BabyEvent) => {
    const t = Date.parse(e.occurredAt);
    return [since(t, now), { em: '', rest: `at ${time(t)}` }];
  };
  const find = <T extends BabyEvent>(test: (e: BabyEvent) => e is T) => events.find(test);

  const feed = find(
    (e): e is Breastfeed => e.type === 'breastfeed' && e.data.durationSeconds !== null,
  );
  const wet = events.find((e) => e.type === 'diaper' && e.data.kind !== 'dirty');
  const dirty = events.find((e) => e.type === 'diaper' && e.data.kind !== 'wet');
  const bottle = find((e): e is Extract<BabyEvent, { type: 'bottle' }> => e.type === 'bottle');
  const pump = lastPump(events);

  return {
    feed: feed ? [...at(feed), sideLine(feed.data.side)] : NOT_YET,
    wet: wet ? at(wet) : NOT_YET,
    dirty: dirty ? at(dirty) : NOT_YET,
    bottle: bottle ? [at(bottle)[0]!, { em: '', rest: volume(bottle.data.volumeMl) }] : NOT_YET,
    pump: pump ? [at(pump)[0]!, sideLine(pumpSide(pump))] : NOT_YET,
  };
}

/** The accessible name: the label, then every line as one sentence. */
export function keyName(label: string, lines: readonly KeyLine[]): string {
  return [label, ...lines.map((l) => `${l.em}${l.rest}`.trim())].join(', ');
}
