import { newId, parseEvent, toMl, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  ageDays,
  cappedStart,
  clock,
  countMarks,
  currentSide,
  dayMarks,
  describe as describeEvent,
  editLink,
  finishFeedData,
  hm,
  intake24h,
  lastSide,
  latestStart,
  MAX_FEED_SECONDS,
  polar,
  runningFeed,
  saveFailure,
  segmentStart,
  sideTimes,
  snapBottle,
  startFeedData,
  stepBottle,
  stopSeconds,
  suggestSide,
  switchFeedData,
  typedSide,
  type Breastfeed,
} from './logic.ts';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const baby = newId();

function ev(type: BabyEvent['type'], data: unknown, minutesAgo: number): BabyEvent {
  const at = new Date(NOW - minutesAgo * 60_000).toISOString();
  return {
    id: newId(),
    babyId: baby,
    authorId: baby,
    occurredAt: at,
    recordedAt: at,
    version: 1,
    deleted: false,
    notes: null,
    type,
    data,
  } as BabyEvent;
}

describe('breastfeed timer', () => {
  test('the running feed is the one without a duration', () => {
    const running = ev('breastfeed', { side: 'left', durationSeconds: null }, 5);
    const done = ev('breastfeed', { side: 'right', durationSeconds: 600 }, 60);
    expect(runningFeed([running, done])?.id).toBe(running.id);
    expect(runningFeed([done])).toBeUndefined();
  });

  test('stop keeps the real duration and refuses one past the schema bound', () => {
    const start = new Date(NOW - 8 * 60_000 - 42_000).toISOString();
    expect(stopSeconds(start, NOW)).toBe(522);
    expect(stopSeconds(new Date(NOW).toISOString(), NOW)).toBe(1);
    expect(stopSeconds(new Date(NOW + 5000).toISOString(), NOW)).toBe(1);
    const limit = new Date(NOW - MAX_FEED_SECONDS * 1000).toISOString();
    expect(stopSeconds(limit, NOW)).toBe(MAX_FEED_SECONDS);
    // Never clamped: an overlong timer has no duration until the parent supplies one.
    expect(stopSeconds(limit, NOW + 1000)).toBeNull();
    expect(stopSeconds(new Date(NOW - 5 * 3_600_000).toISOString(), NOW)).toBeNull();
  });

  test('the next side alternates from the last finished feed, ignoring the running one', () => {
    const events = [
      ev('breastfeed', { side: 'right', durationSeconds: null }, 1),
      ev('breastfeed', { side: 'left', durationSeconds: 900 }, 90),
    ];
    expect(lastSide(events)).toBe('left');
    expect(suggestSide(events)).toBe('right');
    expect(suggestSide([])).toBe('left');
    expect(suggestSide([ev('breastfeed', { side: 'both', durationSeconds: 60 }, 3)])).toBe('left');
  });

  test("a typed duration keeps the running feed's side, whatever the suggestion", () => {
    // The last finished feed was right, so the suggestion is left: the running side must win.
    const done = ev('breastfeed', { side: 'right', durationSeconds: 900 }, 300);
    for (const side of ['right', 'both', 'left'] as const) {
      const events = [ev('breastfeed', { side, durationSeconds: null }, 290), done];
      expect(typedSide(events)).toBe(side);
    }
    expect(typedSide([done])).toBe('left');
    expect(typedSide([])).toBe('left');
  });
});

describe('per-side timing (#19)', () => {
  /** A running feed that started `minutesAgo`, with its data checked against the schema. */
  function feed(data: Breastfeed['data'], minutesAgo: number): Breastfeed {
    const e = ev('breastfeed', data, minutesAgo) as Breastfeed;
    const r = parseEvent(e);
    if (!r.ok) throw new Error(r.errors.join('; '));
    return e;
  }
  const MIN = 60_000;

  test('starting on either side opens one segment on it', () => {
    for (const side of ['left', 'right'] as const) {
      const f = feed(startFeedData(side), 3);
      expect(currentSide(f)).toBe(side);
      expect(sideTimes(f, NOW)).toEqual({ left: 0, right: 0, [side]: 3 * MIN });
    }
  });

  test('switching closes the first side and keeps both durations to the stop', () => {
    const f = feed(startFeedData('left'), 14);
    const switched = feed(switchFeedData(f, NOW - 6 * MIN)!, 14);
    expect(switched.data).toEqual({
      side: 'both',
      durationSeconds: null,
      segments: [
        { side: 'left', seconds: 480 },
        { side: 'right', seconds: null },
      ],
    });
    expect(currentSide(switched)).toBe('right');
    expect(segmentStart(switched)).toBe(NOW - 6 * MIN);
    expect(sideTimes(switched, NOW)).toEqual({ left: 8 * MIN, right: 6 * MIN });

    const done = feed(finishFeedData(switched, NOW)!, 14);
    expect(done.data).toEqual({
      side: 'both',
      durationSeconds: 840,
      segments: [
        { side: 'left', seconds: 480 },
        { side: 'right', seconds: 360 },
      ],
    });
    expect(describeEvent(done, String)).toBe('Breastfeed · left 8 min · right 6 min');
  });

  test('switching back adds a third segment and adds the time per side', () => {
    let f = feed(startFeedData('left'), 20);
    f = feed(switchFeedData(f, NOW - 15 * MIN)!, 20);
    f = feed(switchFeedData(f, NOW - 5 * MIN)!, 20);
    expect(f.data.segments?.map((s) => s.side)).toEqual(['left', 'right', 'left']);
    expect(sideTimes(f, NOW)).toEqual({ left: 10 * MIN, right: 10 * MIN });
    expect(feed(finishFeedData(f, NOW)!, 20).data.durationSeconds).toBe(1200);
  });

  test('a one-side timer stops with its one segment closed', () => {
    const done = feed(finishFeedData(feed(startFeedData('right'), 9), NOW)!, 9);
    expect(done.data).toEqual({
      side: 'right',
      durationSeconds: 540,
      segments: [{ side: 'right', seconds: 540 }],
    });
    expect(describeEvent(done, String)).toBe('Breastfeed · right · 9 min');
  });

  test('a start moved later than the earlier sides never yields a negative side', () => {
    const f = feed(switchFeedData(feed(startFeedData('left'), 10), NOW - 2 * MIN)!, 10);
    expect(latestStart(f, NOW)).toBe(NOW - 8 * MIN);
    // Even if a start slipped past that cap, the stop still saves a valid feed.
    const late = feed({ ...f.data }, 5);
    const done = feed(finishFeedData(late, NOW)!, 5);
    expect(done.data.segments?.at(-1)?.seconds).toBe(0);
    expect(done.data.durationSeconds).toBe(480);
  });

  test('a feed from before per-side timing still stops, and an old both timer cannot switch', () => {
    const old = feed({ side: 'left', durationSeconds: null }, 7);
    expect(currentSide(old)).toBe('left');
    expect(finishFeedData(old, NOW)).toEqual({ side: 'left', durationSeconds: 420 });
    const both = feed({ side: 'both', durationSeconds: null }, 7);
    expect(currentSide(both)).toBeNull();
    expect(switchFeedData(both, NOW)).toBeNull();
    expect(sideTimes(both, NOW)).toBeNull();
  });

  test('switching or stopping an overrun timer saves nothing', () => {
    const f = feed(startFeedData('left'), MAX_FEED_SECONDS / 60 + 1);
    expect(switchFeedData(f, NOW)).toBeNull();
    expect(finishFeedData(f, NOW)).toBeNull();
  });

  test('the next side is the other one from where the last feed started', () => {
    const switched = feed(
      {
        side: 'both',
        durationSeconds: 840,
        segments: [
          { side: 'right', seconds: 480 },
          { side: 'left', seconds: 360 },
        ],
      },
      30,
    );
    expect(suggestSide([switched])).toBe('left');
    expect(lastSide([switched])).toBe('both');
  });
});

describe('dial', () => {
  test('counts the last 24 hours only; a mixed diaper is wet and dirty', () => {
    const events = [
      ev('diaper', { kind: 'wet' }, 10),
      ev('diaper', { kind: 'mixed', stool: null }, 20),
      ev('diaper', { kind: 'dirty', stool: null }, 30),
      ev('bottle', { contents: 'formula', volumeMl: 60 }, 40),
      ev('breastfeed', { side: 'left', durationSeconds: 600 }, 50),
      ev('diaper', { kind: 'wet' }, 24 * 60), // exactly 24 h ago: outside
      ev('diaper', { kind: 'wet' }, -5), // future: outside
    ];
    expect(countMarks(dayMarks(events, NOW))).toEqual({ feed: 2, wet: 2, dirty: 2 });
  });

  test('marks sit at the local hour of day', () => {
    const at = new Date(NOW - 30 * 60_000);
    const [m] = dayMarks([ev('diaper', { kind: 'wet' }, 30)], NOW);
    expect(m?.hour).toBeCloseTo(at.getHours() + at.getMinutes() / 60);
  });

  test('polar puts 0 h at the top and 6 h on the right', () => {
    expect(polar(0, 100)).toEqual([150, 50]);
    expect(polar(6, 100)).toEqual([250, 150]);
    expect(polar(12, 100)).toEqual([150, 250]);
  });
});

describe('bottle level', () => {
  test('snaps to 5 mL, or to 0.5 oz for ounce readers', () => {
    expect(snapBottle(62, 'ml')).toBe(60);
    expect(snapBottle(63, 'both')).toBe(65);
    expect(snapBottle(62, 'oz')).toBe(toMl(2, 'oz'));
    expect(snapBottle(-10, 'ml')).toBe(0);
    expect(snapBottle(999, 'ml')).toBe(240);
  });

  test('steps one notch', () => {
    expect(stepBottle(60, 'ml', 1)).toBe(65);
    expect(stepBottle(toMl(2, 'oz'), 'oz', -1)).toBeCloseTo(toMl(1.5, 'oz'));
    expect(stepBottle(0, 'ml', -1)).toBe(0);
  });
});

describe('readouts', () => {
  test('clock and h:mm', () => {
    expect(clock(522_000)).toBe('08:42');
    expect(clock(3_600_000 + 522_000)).toBe('1:08:42');
    expect(clock(-5)).toBe('00:00');
    expect(hm(2 * 3_600_000 + 5 * 60_000)).toBe('2:05');
  });

  test('age in whole days, 0 on the birth day', () => {
    expect(ageDays(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe(0);
    expect(ageDays(new Date(NOW - 12.5 * 86_400_000).toISOString(), NOW)).toBe(12);
  });

  test('recorded intake sums bottles and counts unmeasured breastfeeds', () => {
    const events = [
      ev('bottle', { contents: 'formula', volumeMl: 60 }, 10),
      ev('bottle', { contents: 'breast_milk', volumeMl: 45 }, 300),
      ev('bottle', { contents: 'formula', volumeMl: 90 }, 25 * 60),
      ev('breastfeed', { side: 'left', durationSeconds: 600 }, 50),
    ];
    expect(intake24h(events, NOW)).toEqual({ bottleMl: 105, unmeasured: 1 });
  });

  test('describes events for toasts', () => {
    const vol = (ml: number) => `${ml} mL`;
    expect(describeEvent(ev('diaper', { kind: 'wet' }, 1), vol)).toBe('Wet diaper');
    expect(
      describeEvent(
        ev(
          'diaper',
          {
            kind: 'mixed',
            stool: { color: 'pale_yellow', consistency: null, size: null, flags: [] },
          },
          1,
        ),
        vol,
      ),
    ).toBe('Mixed diaper · pale yellow');
    expect(describeEvent(ev('bottle', { contents: 'formula', volumeMl: 60 }, 1), vol)).toBe(
      'Bottle · formula · 60 mL',
    );
  });
});

describe('saveFailure', () => {
  test('names a full phone, and says nothing was saved otherwise', () => {
    expect(saveFailure(new DOMException('full', 'QuotaExceededError'))).toMatch(/out of storage/);
    expect(saveFailure(new Error('boom'))).toMatch(/^Not saved/);
    expect(saveFailure('weird')).toMatch(/^Not saved/);
  });
});

describe('editLink', () => {
  test('wet, bottle and finished feeds open the shared Logged screen', () => {
    for (const e of [
      ev('diaper', { kind: 'wet' }, 0),
      ev('bottle', { contents: 'formula', volumeMl: 60 }, 0),
      ev('breastfeed', { side: 'left', durationSeconds: 600 }, 10),
    ]) {
      expect(editLink(e)).toEqual({ label: 'Change time', path: `/logged?id=${e.id}` });
    }
  });
  test('dirty diapers reopen their details, a running feed its timer', () => {
    const dirty = ev(
      'diaper',
      { kind: 'dirty', stool: { color: 'yellow', consistency: null, size: null, flags: [] } },
      0,
    );
    expect(editLink(dirty)).toEqual({ label: 'Details', path: `/diaper/details?id=${dirty.id}` });
    const running = ev('breastfeed', { side: 'left', durationSeconds: null }, 3);
    expect(editLink(running)?.path).toBe('/feed');
    const mark = ev(
      'missed_logs',
      { start: new Date(NOW - 60_000).toISOString(), end: new Date(NOW).toISOString() },
      1,
    );
    expect(editLink(mark)).toBeUndefined();
  });
});

test('latestStart keeps a finished feed ending by now', () => {
  expect(latestStart(ev('breastfeed', { side: 'left', durationSeconds: 900 }, 15), NOW)).toBe(
    NOW - 900_000,
  );
  expect(latestStart(ev('diaper', { kind: 'wet' }, 0), NOW)).toBeUndefined();
});

describe('cappedStart', () => {
  // Completed an hour ago, 30 seconds long: it can start no later than 30 s before now.
  const feed = ev('breastfeed', { side: 'left', durationSeconds: 30 }, 60);
  const iso = (ms: number) => new Date(ms).toISOString();

  test('Now on a completed 30-second feed saves the exact latest start, never a future end', () => {
    const start = cappedStart(feed, null, NOW);
    expect(start).toBe(iso(NOW - 30_000));
    expect(Date.parse(start) + 30_000).toBeLessThanOrEqual(NOW);
  });
  test('a time inside the last 30 seconds clamps to the cap and stays a timestamp', () => {
    expect(cappedStart(feed, iso(NOW - 10_000), NOW)).toBe(iso(NOW - 30_000));
  });
  test('a time at or before the cap is kept exactly', () => {
    expect(cappedStart(feed, iso(NOW - 30_000), NOW)).toBe(iso(NOW - 30_000));
    expect(cappedStart(feed, feed.occurredAt, NOW)).toBe(feed.occurredAt);
  });
  test('an uncapped event saves Now as now', () => {
    expect(cappedStart(ev('diaper', { kind: 'wet' }, 5), null, NOW)).toBe(iso(NOW));
  });
});
