import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '@bht/insights';
import { newId, parseEvent, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { minutes } from './logic.ts';
import {
  addDays,
  averages,
  clockChange,
  dayState,
  dayWindow,
  eventsIn,
  feedBar,
  feedEnd,
  hourText,
  fullDay,
  isSecondOccurrence,
  markedMissing,
  midnightIn,
  mondayOf,
  parseYmd,
  reportDay,
  rowText,
  tally,
  ticks,
  wall,
  windowHours,
  windowText,
  zoned,
  type Ymd,
} from './reports.ts';

// The design board's cases (docs/design/direction.html?board=reports&case=...), in a real
// daylight-saving zone. Every expectation is an instant, so the host's own zone does not matter.
const NY = 'America/New_York';
const H = 3_600_000;
const EIGHT = 8 * 60;
const baby = newId();

const iso = (s: string) => new Date(s).toISOString();

function ev(type: BabyEvent['type'], at: string, data: unknown): BabyEvent {
  const r = parseEvent({
    id: newId(),
    babyId: baby,
    authorId: baby,
    occurredAt: iso(at),
    recordedAt: iso(at),
    version: 1,
    deleted: false,
    notes: null,
    type,
    data,
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}
const wet = (at: string) => ev('diaper', at, { kind: 'wet' });
const dirty = (at: string) => ev('diaper', at, { kind: 'dirty', stool: null });
const mixed = (at: string) => ev('diaper', at, { kind: 'mixed', stool: null });
const feed = (at: string, min = 15) =>
  ev('breastfeed', at, { side: 'left', durationSeconds: min * 60 });
const bottle = (at: string, ml: number) =>
  ev('bottle', at, { contents: 'breast_milk', volumeMl: ml });
const weight = (at: string, grams: number) => ev('weight', at, { grams, source: 'clinic' });

const MON: Ymd = { y: 2026, m: 10, d: 26 };
const TUE: Ymd = { y: 2026, m: 10, d: 27 };

describe('day windows', () => {
  test('an 8 AM day runs 8 AM to 8 AM, 24 h on an ordinary day', () => {
    const w = dayWindow(MON, EIGHT, NY);
    expect(new Date(w.start).toISOString()).toBe('2026-10-26T12:00:00.000Z');
    expect(new Date(w.end).toISOString()).toBe('2026-10-27T12:00:00.000Z');
    expect(windowHours(w)).toBe(24);
    expect(clockChange(w, NY)).toBeNull();
    expect(new Date(midnightIn(w, NY)!).toISOString()).toBe('2026-10-27T04:00:00.000Z');
    expect(midnightIn(dayWindow(MON, 0, NY), NY)).toBeNull();
  });

  test('3:00 AM Tuesday is Monday with an 8 AM start, Tuesday with midnight', () => {
    const t = Date.parse('2026-10-27T07:00:00Z'); // 3:00 AM EDT
    expect(wall(t, NY)).toMatchObject({ d: 27, h: 3, min: 0 });
    expect(reportDay(t, EIGHT, NY)).toEqual(MON);
    expect(reportDay(t, 0, NY)).toEqual(TUE);
    // The edges: the start belongs to its own day, a minute before belongs to the day before.
    expect(reportDay(Date.parse('2026-10-27T12:00:00Z'), EIGHT, NY)).toEqual(TUE);
    expect(reportDay(Date.parse('2026-10-27T11:59:00Z'), EIGHT, NY)).toEqual(MON);
  });

  test('25 h: clocks go back inside Sat Oct 31, 8 AM to 8 AM Sun', () => {
    const w = dayWindow({ y: 2026, m: 10, d: 31 }, EIGHT, NY);
    expect(windowHours(w)).toBe(25);
    const change = clockChange(w, NY)!;
    expect(change.back).toBe(true);
    expect(new Date(change.at).toISOString()).toBe('2026-11-01T06:00:00.000Z');
    // 1:30 AM happens twice; the second is an hour after the first and is marked.
    const first = zoned({ y: 2026, m: 11, d: 1 }, 90, NY);
    const second = zoned({ y: 2026, m: 11, d: 1 }, 90, NY, 2);
    expect(new Date(first).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(second - first).toBe(H);
    expect(isSecondOccurrence(first, NY)).toBe(false);
    expect(isSecondOccurrence(second, NY)).toBe(true);
    expect(isSecondOccurrence(second + 30_000, NY)).toBe(true);
    // Both are Saturday's, and the ticks follow the clock: 8 AM, 2 PM, 8 PM, 2 AM, 8 AM.
    expect(reportDay(second, EIGHT, NY)).toEqual({ y: 2026, m: 10, d: 31 });
    expect(ticks(w, EIGHT, NY).map((t) => wall(t, NY).h)).toEqual([8, 14, 20, 2, 8]);
  });

  test('23 h: clocks go forward inside Sat Mar 13 2027, and there is no 2 AM', () => {
    const w = dayWindow({ y: 2027, m: 3, d: 13 }, EIGHT, NY);
    expect(windowHours(w)).toBe(23);
    expect(clockChange(w, NY)).toMatchObject({ back: false });
    // The tick that would be 2 AM is the instant the clocks reach it: 3 AM.
    expect(ticks(w, EIGHT, NY).map((t) => wall(t, NY).h)).toEqual([8, 14, 20, 3, 8]);
    // 1:50 AM EST to 3:10 AM EDT is 20 minutes.
    const a = zoned({ y: 2027, m: 3, d: 14 }, 110, NY);
    const b = zoned({ y: 2027, m: 3, d: 14 }, 190, NY);
    expect(b - a).toBe(20 * 60_000);
  });

  test('a midnight start makes the change day itself 25 h or 23 h', () => {
    expect(windowHours(dayWindow({ y: 2026, m: 11, d: 1 }, 0, NY))).toBe(25);
    expect(windowHours(dayWindow({ y: 2027, m: 3, d: 14 }, 0, NY))).toBe(23);
  });

  test('a day start inside the skipped hour moves to when the clocks reach it', () => {
    const w = dayWindow({ y: 2027, m: 3, d: 14 }, 150, NY); // 2:30 AM does not exist
    expect(wall(w.start, NY)).toMatchObject({ h: 3, min: 30 });
    const t = zoned({ y: 2027, m: 3, d: 14 }, 190, NY); // 3:10 AM, before that start
    expect(reportDay(t, 150, NY)).toEqual({ y: 2027, m: 3, d: 13 });
  });

  test('dates and weeks', () => {
    expect(addDays({ y: 2026, m: 10, d: 31 }, 1)).toEqual({ y: 2026, m: 11, d: 1 });
    expect(mondayOf({ y: 2026, m: 11, d: 1 })).toEqual(MON);
    expect(mondayOf(MON)).toEqual(MON);
    expect(parseYmd('2026-10-26')).toEqual(MON);
    expect(parseYmd('2026-02-30')).toBeNull();
    expect(parseYmd('26-10-2026')).toBeNull();
    expect(parseYmd(null)).toBeNull();
  });
});

// Monday Oct 26 from the board: 8 diapers (5 wet, 3 dirty), 9 feeds, 180 mL, one weight.
const MONDAY = [
  feed('2026-10-26T08:40:00-04:00', 14),
  wet('2026-10-26T10:05:00-04:00'),
  weight('2026-10-26T10:30:00-04:00', 3580),
  dirty('2026-10-26T11:20:00-04:00'),
  bottle('2026-10-26T11:50:00-04:00', 60),
  feed('2026-10-26T13:10:00-04:00', 18),
  wet('2026-10-26T14:00:00-04:00'),
  bottle('2026-10-26T15:30:00-04:00', 60),
  feed('2026-10-26T16:45:00-04:00', 12),
  dirty('2026-10-26T17:30:00-04:00'),
  feed('2026-10-26T19:10:00-04:00', 16),
  wet('2026-10-26T20:00:00-04:00'),
  bottle('2026-10-26T22:40:00-04:00', 60),
  wet('2026-10-26T23:30:00-04:00'),
  feed('2026-10-27T01:40:00-04:00', 15),
  wet('2026-10-27T02:05:00-04:00'),
  feed('2026-10-27T03:00:00-04:00', 20),
  dirty('2026-10-27T04:10:00-04:00'),
];

describe('counts', () => {
  test('summary counts match the events the timeline draws', () => {
    const w = dayWindow(MON, EIGHT, NY);
    const day = eventsIn(MONDAY, w.start, w.end);
    expect(day).toHaveLength(MONDAY.length);
    expect(Date.parse(day[0]!.occurredAt)).toBeLessThan(Date.parse(day[1]!.occurredAt));
    const c = tally(day);
    expect(c).toMatchObject({ diapers: 8, wet: 5, dirty: 3, breast: 6, bottle: 3, bottleMl: 180 });
    expect(c.weights.map((x) => x.data.grams)).toEqual([3580]);
  });

  test('moving the day start moves events between days, and nothing is lost', () => {
    const at = (d: Ymd, start: number) => {
      const w = dayWindow(d, start, NY);
      return tally(eventsIn(MONDAY, w.start, w.end));
    };
    // Midnight: the four after-midnight events leave Monday for Tuesday.
    expect(at(MON, 0)).toMatchObject({ diapers: 6, breast: 4 });
    expect(at(TUE, 0)).toMatchObject({ diapers: 2, breast: 2 });
    expect(at(MON, 0).diapers + at(TUE, 0).diapers).toBe(at(MON, EIGHT).diapers);
  });

  test('a mixed diaper is one diaper, and counts as wet and as dirty', () => {
    expect(tally([mixed('2026-10-26T09:00:00-04:00')])).toMatchObject({
      diapers: 1,
      wet: 1,
      dirty: 1,
    });
  });

  test('25 h day: both 1:30 AM events count, once each', () => {
    const sat = { y: 2026, m: 10, d: 31 };
    const w = dayWindow(sat, EIGHT, NY);
    const first = new Date(zoned({ y: 2026, m: 11, d: 1 }, 90, NY)).toISOString();
    const second = new Date(zoned({ y: 2026, m: 11, d: 1 }, 90, NY, 2)).toISOString();
    const events = [
      feed('2026-10-31T08:20:00-04:00'),
      feed(first),
      wet(second),
      wet('2026-11-01T07:59:00-05:00'),
      wet('2026-11-01T08:00:00-05:00'), // Sunday's
    ];
    expect(tally(eventsIn(events, w.start, w.end))).toMatchObject({ breast: 2, wet: 2 });
  });

  test('a test weighing is listed as a measurement; its breastfeed is the feed', () => {
    const f = feed('2026-10-26T09:00:00-04:00', 12);
    const weighed = ev('weighted_feed', '2026-10-26T09:13:00-04:00', {
      beforeGrams: 3500,
      afterGrams: 3540,
      side: 'left',
    });
    const w = dayWindow(MON, EIGHT, NY);
    const day = eventsIn([f, weighed], w.start, w.end);
    expect(day).toHaveLength(2);
    expect(tally(day)).toMatchObject({ breast: 1, bottle: 0, bottleMl: 0 });
    expect(rowText(weighed as Extract<BabyEvent, { type: 'weighted_feed' }>, String)).toEqual({
      glyph: null,
      name: 'Test weighing · +40 g',
      detail: 'Left · Approximate, not counted as a feed',
    });
  });

  test('a "We missed some" mark is not a logged event', () => {
    const mark = ev('missed_logs', '2026-10-26T09:00:00-04:00', {
      start: iso('2026-10-26T09:00:00-04:00'),
      end: iso('2026-10-26T12:00:00-04:00'),
    });
    const w = dayWindow(MON, EIGHT, NY);
    expect(eventsIn([...MONDAY, mark], w.start, w.end)).toHaveLength(MONDAY.length);
  });

  test('a day with a "We missed some" mark is noted, and its counts are unchanged', () => {
    // Marks cover a day-of-life window, which can cross the household's day start.
    const mark = ev('missed_logs', '2026-10-26T09:00:00-04:00', {
      start: iso('2026-10-26T10:42:00-04:00'),
      end: iso('2026-10-27T10:42:00-04:00'),
    });
    const at = (d: Ymd, start: number) => {
      const w = dayWindow(d, start, NY);
      return markedMissing([...MONDAY, mark], w.start, w.end);
    };
    expect([at(addDays(MON, -1), EIGHT), at(MON, EIGHT), at(addDays(MON, 1), EIGHT)]).toEqual([
      false,
      true,
      true,
    ]);
    expect(at(addDays(MON, 2), EIGHT)).toBe(false);
    // Edges are half-open: a mark ending exactly at a day start does not touch that day.
    const edge = ev('missed_logs', '2026-10-26T09:00:00-04:00', {
      start: iso('2026-10-26T06:00:00-04:00'),
      end: iso('2026-10-26T08:00:00-04:00'),
    });
    const mon = dayWindow(MON, EIGHT, NY);
    const sun = dayWindow(addDays(MON, -1), EIGHT, NY);
    expect(markedMissing([edge], mon.start, mon.end)).toBe(false);
    expect(markedMissing([edge], sun.start, sun.end)).toBe(true);
    // A taken-back mark ("We logged everything" deletes it) notes nothing.
    expect(markedMissing([{ ...mark, deleted: true }], mon.start, mon.end)).toBe(false);
    expect(markedMissing(MONDAY, mon.start, mon.end)).toBe(false);
    // The note never changes what is counted.
    expect(tally(eventsIn([...MONDAY, mark], mon.start, mon.end))).toEqual(
      tally(eventsIn(MONDAY, mon.start, mon.end)),
    );
  });

  test('averages count finished days only', () => {
    const now = Date.parse('2026-10-29T07:00:00Z'); // 3 AM Thu: Wed is still under way at 8 AM
    const birth = Date.parse('2026-10-20T08:00:00-04:00');
    const days = [0, 1, 2, 3].map((i) => {
      const win = dayWindow(addDays(MON, i), EIGHT, NY);
      return { tally: tally(eventsIn(MONDAY, win.start, win.end)), win, state: dayState(win, now) };
    });
    expect(days.map((x) => x.state)).toEqual(['done', 'done', 'today', 'future']);
    expect(averages(days, birth, now)).toEqual({ days: 2, diapers: 4, feeds: 4.5, bottleMl: 90 });
    expect(averages(days.slice(2), birth, now)).toBeNull();
  });
});

describe('averages around birth', () => {
  const WED: Ymd = { y: 2026, m: 10, d: 28 };
  const sixFeeds = [9, 11, 13, 15, 17, 19].map((h) =>
    feed(`2026-10-28T${String(h).padStart(2, '0')}:00:00-04:00`),
  );
  const days = (dates: Ymd[], events: BabyEvent[]) =>
    dates.map((d) => {
      const win = dayWindow(d, EIGHT, NY);
      return { tally: tally(eventsIn(events, win.start, win.end)), win };
    });
  const week = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(MON, i));

  test('Week and Month agree when birth falls on the day start', () => {
    const birth = Date.parse('2026-10-28T08:00:00-04:00');
    const now = Date.parse('2026-10-29T12:00:00-04:00');
    // Week passes all seven days; Month passes birth day to today. Mon and Tue are before birth.
    const w = averages(days(week, sixFeeds), birth, now);
    const m = averages(days([WED, addDays(WED, 1)], sixFeeds), birth, now);
    expect(w).toMatchObject({ days: 1, feeds: 6 });
    expect(m).toEqual(w);
  });

  test('a birth after the day start makes the birth day partial: shown, not averaged', () => {
    const birth = Date.parse('2026-10-28T14:00:00-04:00');
    const now = Date.parse('2026-10-30T12:00:00-04:00'); // Fri noon: Thu is the one full day
    const thu = [10, 14].map((h) => feed(`2026-10-29T${h}:00:00-04:00`));
    const wed = dayWindow(WED, EIGHT, NY);
    expect(fullDay(wed, birth, now)).toBe(false);
    expect(fullDay(dayWindow(addDays(WED, 1), EIGHT, NY), birth, now)).toBe(true);
    expect(averages(days(week, [...sixFeeds, ...thu]), birth, now)).toMatchObject({
      days: 1,
      feeds: 2,
    });
    // Only the partial birth day so far: no average at all.
    expect(averages(days(week, sixFeeds), birth, Date.parse('2026-10-29T09:00:00-04:00'))).toBe(
      null,
    );
  });

  test('a week with today in it averages the ended days only', () => {
    const birth = Date.parse('2026-10-01T08:00:00-04:00');
    const now = Date.parse('2026-10-28T12:00:00-04:00'); // Wed noon
    const avg = averages(days(week, [...MONDAY, ...sixFeeds]), birth, now)!;
    expect(avg.days).toBe(2); // Mon, Tue; Wed is today, Thu to Sun are to come
    expect(avg).toEqual(averages(days([MON, TUE], MONDAY), birth, now));
  });
});

describe('timeline bars', () => {
  // The Day timeline's x scale: 332 wide with 4 px either side.
  const mon = dayWindow(MON, EIGHT, NY);
  const x = (t: number) => 4 + ((t - mon.start) / (mon.end - mon.start)) * 324;
  const long = ev('breastfeed', '2026-10-27T07:59:00-04:00', {
    side: 'left',
    durationSeconds: 4 * 3600,
  });

  test('a four-hour feed from 7:59 AM stops at the window edge, at minimum width', () => {
    const t = Date.parse(long.occurredAt);
    const [left, right] = feedBar(t, t + 4 * H, mon, x, 3);
    expect(right).toBe(x(mon.end));
    expect(right - left).toBeCloseTo(3);
    // Week's mini strip: 326 wide, minimum 3 × 0.62.
    const xm = (u: number) => 4 + ((u - mon.start) / (mon.end - mon.start)) * 318;
    const [l2, r2] = feedBar(t, t + 4 * H, mon, xm, 3 * 0.62);
    expect(r2).toBe(xm(mon.end));
    expect(r2 - l2).toBeCloseTo(1.86);
  });

  test('it counts once, on the day it starts, and its row keeps the true duration', () => {
    const tue = dayWindow(TUE, EIGHT, NY);
    expect(tally(eventsIn([long], mon.start, mon.end)).breast).toBe(1);
    expect(tally(eventsIn([long], tue.start, tue.end)).breast).toBe(0);
    const [row] = eventsIn([long], mon.start, mon.end);
    expect(rowText(row!, String).detail).toBe(`Left · ${minutes(4 * 3600)}`);
  });

  test('bars are clipped on the left edge too, and short feeds keep minimum width', () => {
    const [l, r] = feedBar(mon.start - H, mon.start + H, mon, x, 3);
    expect(l).toBe(x(mon.start));
    expect(r).toBeCloseTo(x(mon.start + H));
    const noon = Date.parse('2026-10-26T12:00:00-04:00');
    expect(feedBar(noon, noon + 60_000, mon, x, 3)).toEqual([x(noon), x(noon) + 3]);
    expect(feedBar(noon, noon + H, mon, x, 3)).toEqual([x(noon), x(noon + H)]);
  });
});

describe('pumps and paused feeds (#29, #32)', () => {
  const pump = (at: string, data: object) =>
    ev('pump', at, { leftMl: null, rightMl: null, afterFeed: false, ...data });

  test('a running pump and one with no amount are listed and counted, with no mL', () => {
    const running = pump('2026-10-26T09:00:00-04:00', { side: 'both', durationSeconds: null });
    const stopped = pump('2026-10-26T10:00:00-04:00', { side: 'left', durationSeconds: 1500 });
    const logged = pump('2026-10-26T11:00:00-04:00', { leftMl: 60, rightMl: 40 });
    const day = [running, stopped, logged, bottle('2026-10-26T12:00:00-04:00', 60)];
    expect(tally(day)).toMatchObject({ pumps: 3, bottle: 1, bottleMl: 60 });
    const row = (e: BabyEvent) => rowText(e as Extract<BabyEvent, { type: 'pump' }>, String);
    expect(row(running)).toEqual({ glyph: 'pump', name: 'Pump', detail: 'Both · running' });
    expect(row(stopped)).toEqual({
      glyph: 'pump',
      name: 'Pump',
      detail: `Left · ${minutes(1500)} · amount not entered`,
    });
    expect(row(logged).detail).toBe('L 60 · R 40');
  });

  test('a paused feed: the bar spans its pauses, the row shows feeding time only', () => {
    const f = ev('breastfeed', '2026-10-26T09:00:00-04:00', {
      side: 'left',
      durationSeconds: 15 * 60,
      pausedSeconds: 5 * 60,
    }) as Extract<BabyEvent, { type: 'breastfeed' }>;
    expect(feedEnd(f, 0)).toBe(Date.parse('2026-10-26T09:20:00-04:00'));
    expect(rowText(f, String).detail).toBe(`Left · ${minutes(15 * 60)}`);
    expect(tally([f]).breast).toBe(1);
  });

  test('a running feed on pause draws to now and reads "Paused"', () => {
    const f = ev('breastfeed', '2026-10-26T09:00:00-04:00', {
      side: 'left',
      durationSeconds: null,
      segments: [{ side: 'left', seconds: null }],
      pausedSeconds: 60,
      pausedAt: iso('2026-10-26T09:10:00-04:00'),
    }) as Extract<BabyEvent, { type: 'breastfeed' }>;
    const now = Date.parse('2026-10-26T09:30:00-04:00');
    expect(feedEnd(f, now)).toBe(now);
    expect(rowText(f, String).detail).toBe('Paused');
  });
});

describe('day starts off the hour', () => {
  const HALF = 7 * 60 + 30;
  const text = (s: string) => s.replace(/\s/g, ' ');

  test('7:30 AM, 25 h: the shaded hour starts when the clocks went back, at 06:00Z', () => {
    const w = dayWindow({ y: 2026, m: 10, d: 31 }, HALF, NY);
    expect(windowHours(w)).toBe(25);
    const c = clockChange(w, NY)!;
    expect(c.back).toBe(true);
    expect(new Date(c.at).toISOString()).toBe('2026-11-01T06:00:00.000Z');
    expect(text(windowText(w, HALF, NY))).toBe('7:30 AM to 7:30 AM Sun · 25 h');
    // The middle ticks round up to the hour, so the labels fit; the ends keep the minutes.
    expect(ticks(w, HALF, NY).map((t) => text(hourText(t, NY)))).toEqual([
      '7:30 AM',
      '2 PM',
      '8 PM',
      '2 AM',
      '7:30 AM',
    ]);
  });

  test('7:30 AM, 23 h: the divider is at 07:00Z, when 2 AM became 3 AM', () => {
    const w = dayWindow({ y: 2027, m: 3, d: 13 }, HALF, NY);
    expect(windowHours(w)).toBe(23);
    const c = clockChange(w, NY)!;
    expect(c.back).toBe(false);
    expect(new Date(c.at).toISOString()).toBe('2027-03-14T07:00:00.000Z');
    expect(wall(c.at, NY)).toMatchObject({ h: 3, min: 0 });
    expect(text(windowText(w, HALF, NY))).toBe('7:30 AM to 7:30 AM Sun · 23 h');
  });

  test('an ordinary 7:30 AM day keeps its minutes and has no change', () => {
    const w = dayWindow(MON, HALF, NY);
    expect(clockChange(w, NY)).toBeNull();
    expect(text(windowText(w, HALF, NY))).toBe('7:30 AM to 7:30 AM Tue');
  });

  test('a 2:30 AM start inside the skipped hour: the change is in the day before', () => {
    const START = 150;
    // Sat: 2:30 AM EST to 3:30 AM EDT is 24 real hours, and the clocks go forward inside it.
    const sat = dayWindow({ y: 2027, m: 3, d: 13 }, START, NY);
    expect(windowHours(sat)).toBe(24);
    expect(new Date(clockChange(sat, NY)!.at).toISOString()).toBe('2027-03-14T07:00:00.000Z');
    expect(text(windowText(sat, START, NY))).toBe('2:30 AM to 3:30 AM Sun');
    // Sun starts when the clocks reach 2:30, at 3:30 AM EDT, and is 23 h with no change in it.
    const sun = dayWindow({ y: 2027, m: 3, d: 14 }, START, NY);
    expect(windowHours(sun)).toBe(23);
    expect(clockChange(sun, NY)).toBeNull();
    expect(text(windowText(sun, START, NY))).toBe('3:30 AM to 2:30 AM Mon · 23 h');
  });
});

describe('Readings ignore Day starts at', () => {
  // Readings get no setting to read: the evaluator's input has no day start, its windows come
  // from the birth time (#11), and nothing on the Readings path imports the setting.
  test('the same log gives identical Readings while Reports regroup it', () => {
    const now = '2026-10-29T16:00:00.000Z';
    const input = {
      baby: { birthAt: '2026-10-17T10:42:00.000Z', sex: 'female' as const },
      events: MONDAY,
      now,
      fullyLogged: [{ start: '2026-10-17T10:42:00.000Z', end: now }],
      syncedThrough: now,
    };
    const readings = (dayStart: number) => {
      // What Reports show changes with the setting (the premise this test needs)...
      const w = dayWindow(MON, dayStart, NY);
      const shown = tally(eventsIn(MONDAY, w.start, w.end)).diapers;
      // ...and Readings are evaluated from the same log, with no way to pass it in.
      return { shown, results: evaluate(input) };
    };
    const midnight = readings(0);
    const eight = readings(EIGHT);
    expect(midnight.shown).not.toBe(eight.shown);
    // A count check really ran on the new evaluator (#30), so the comparison is not vacuous.
    const wet = midnight.results.find((r) => r.check === 'wet_diapers');
    expect(wet?.status).not.toBe('not_enough_data');
    expect(eight.results).toEqual(midnight.results);
  });

  test('nothing on the Readings path reads the setting', () => {
    const root = join(import.meta.dirname, '../../../../..');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
      });
    const readingsPath = [
      ...files(join(root, 'packages/insights/src')),
      join(root, 'apps/web/src/routes/readings/+page.svelte'),
      join(root, 'apps/web/src/lib/ui/readings.ts'),
    ];
    expect(readingsPath.length).toBeGreaterThan(5);
    for (const f of readingsPath) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/dayStart|reports\.ts|\.prefs\b/);
    }
  });
});
