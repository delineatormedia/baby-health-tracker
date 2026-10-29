import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '@bht/insights';
import { newId, parseEvent, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  addDays,
  averages,
  clockChange,
  dayState,
  dayWindow,
  eventsIn,
  isSecondOccurrence,
  midnightIn,
  mondayOf,
  parseYmd,
  reportDay,
  tally,
  ticks,
  wall,
  windowHours,
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

  test('averages count finished days only', () => {
    const now = Date.parse('2026-10-29T07:00:00Z'); // 3 AM Thu: Wed is still under way at 8 AM
    const days = [0, 1, 2, 3].map((i) => {
      const w = dayWindow(addDays(MON, i), EIGHT, NY);
      return { tally: tally(eventsIn(MONDAY, w.start, w.end)), state: dayState(w, now) };
    });
    expect(days.map((x) => x.state)).toEqual(['done', 'done', 'today', 'future']);
    expect(averages(days)).toEqual({ days: 2, diapers: 4, feeds: 4.5, bottleMl: 90 });
    expect(averages(days.slice(2))).toBeNull();
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
    expect(midnight.results.some((r) => r.status !== 'not_enough_data')).toBe(true);
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
