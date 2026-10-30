import { newId, parseEvent, toMl, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { SigningOut } from '../data/store.ts';
import {
  ageDays,
  CAPTION_RADIUS,
  chordWidth,
  cappedStart,
  clock,
  countMarks,
  currentSide,
  dayMarks,
  describe as describeEvent,
  editLink,
  kindName,
  feedElapsed,
  finishFeedData,
  followsFeed,
  lastPump,
  lastPumpMl,
  pumpData,
  pumpSide,
  runningPump,
  startPumpData,
  stopPumpData,
  stoppedPump,
  isPaused,
  pauseFeedData,
  pickSideData,
  resumeFeedData,
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
  type Pump,
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

describe('pause (#29)', () => {
  function feed(data: Breastfeed['data'], minutesAgo: number): Breastfeed {
    const e = ev('breastfeed', data, minutesAgo) as Breastfeed;
    const r = parseEvent(e);
    if (!r.ok) throw new Error(r.errors.join('; '));
    return e;
  }
  const MIN = 60_000;
  /** Reloading means reading the stored event back; nothing else carries timer state. */
  const reload = (f: Breastfeed) =>
    feed(JSON.parse(JSON.stringify(f.data)), (NOW - Date.parse(f.occurredAt)) / MIN);

  test('start, pause 2 min, resume, stop: the 2 min are not in the feed', () => {
    // Started 12 min ago, paused at -8 for 2 min, resumed at -6, stopped now.
    let f = feed(startFeedData('left'), 12);
    f = feed(pauseFeedData(f, NOW - 8 * MIN), 12);
    expect(isPaused(f)).toBe(true);
    f = feed(resumeFeedData(f, NOW - 6 * MIN)!, 12);
    expect(isPaused(f)).toBe(false);
    expect(f.data.pausedSeconds).toBe(120);
    expect(feedElapsed(f, NOW)).toBe(10 * MIN);
    const done = feed(finishFeedData(f, NOW)!, 12);
    expect(done.data).toEqual({
      side: 'left',
      durationSeconds: 600,
      segments: [{ side: 'left', seconds: 600 }],
      pausedSeconds: 120,
    });
  });

  test('the same holds after a reload mid-pause, and the clock stands still while paused', () => {
    let f = feed(startFeedData('left'), 12);
    f = reload(feed(pauseFeedData(f, NOW - 8 * MIN), 12));
    expect(feedElapsed(f, NOW - 7 * MIN)).toBe(4 * MIN);
    expect(feedElapsed(f, NOW - 6 * MIN)).toBe(4 * MIN);
    expect(sideTimes(f, NOW - 6 * MIN)).toEqual({ left: 4 * MIN, right: 0 });
    f = reload(feed(resumeFeedData(f, NOW - 6 * MIN)!, 12));
    expect(feed(finishFeedData(f, NOW)!, 12).data.durationSeconds).toBe(600);
  });

  test('paused time stays out of every side, including a pause before a switch', () => {
    // Left 4 min, pause 3 min, left 2 more, switch, right 5 min.
    let f = feed(startFeedData('left'), 14);
    f = feed(pauseFeedData(f, NOW - 10 * MIN), 14);
    f = feed(resumeFeedData(f, NOW - 7 * MIN)!, 14);
    f = feed(switchFeedData(f, NOW - 5 * MIN)!, 14);
    expect(f.data.segments).toEqual([
      { side: 'left', seconds: 360 },
      { side: 'right', seconds: null },
    ]);
    expect(sideTimes(f, NOW)).toEqual({ left: 6 * MIN, right: 5 * MIN });
    const done = feed(finishFeedData(f, NOW)!, 14);
    expect(done.data.durationSeconds).toBe(660);
    expect(done.data.segments).toEqual([
      { side: 'left', seconds: 360 },
      { side: 'right', seconds: 300 },
    ]);
  });

  test('switching while paused resumes on the other side', () => {
    let f = feed(startFeedData('left'), 10);
    f = feed(pauseFeedData(f, NOW - 6 * MIN), 10);
    f = feed(switchFeedData(f, NOW - 2 * MIN)!, 10);
    expect(isPaused(f)).toBe(false);
    expect(f.data.pausedSeconds).toBe(240);
    expect(f.data.segments?.[0]).toEqual({ side: 'left', seconds: 240 });
    expect(sideTimes(f, NOW)).toEqual({ left: 4 * MIN, right: 2 * MIN });
  });

  test('stopping while paused ends the feed when the pause began', () => {
    let f = feed(startFeedData('right'), 10);
    f = feed(pauseFeedData(f, NOW - 4 * MIN), 10);
    const done = feed(finishFeedData(f, NOW)!, 10);
    expect(done.data).toEqual({
      side: 'right',
      durationSeconds: 360,
      segments: [{ side: 'right', seconds: 360 }],
    });
  });

  test('pause and resume are idempotent, and a pause past 24 h asks for the duration', () => {
    const f = feed(pauseFeedData(feed(startFeedData('left'), 10), NOW - 5 * MIN), 10);
    expect(pauseFeedData(f, NOW)).toBe(f.data);
    const running = feed(startFeedData('left'), 10);
    expect(resumeFeedData(running, NOW)).toBe(running.data);
    const forgotten = feed(
      pauseFeedData(feed(startFeedData('left'), 25 * 60), NOW - (24 * 60 + 1) * MIN),
      25 * 60,
    );
    expect(resumeFeedData(forgotten, NOW)).toBeNull();
  });

  test('a long pause does not make an active feed overrun', () => {
    // 5 hours on the wall clock, 4 of them paused: 1 hour of feeding stops normally.
    let f = feed(startFeedData('left'), 5 * 60);
    f = feed(pauseFeedData(f, NOW - 4.5 * 60 * MIN), 5 * 60);
    f = feed(resumeFeedData(f, NOW - 30 * MIN)!, 5 * 60);
    expect(feed(finishFeedData(f, NOW)!, 5 * 60).data.durationSeconds).toBe(3600);
  });

  test('start can move no later than the sides and pauses already fit', () => {
    let f = feed(startFeedData('left'), 10);
    f = feed(pauseFeedData(f, NOW - 6 * MIN), 10);
    // Paused 4 min into the feed: the start can move up to the pause itself.
    expect(latestStart(f, NOW)).toBe(NOW - 6 * MIN);
    f = feed(resumeFeedData(f, NOW - 2 * MIN)!, 10);
    expect(latestStart(f, NOW)).toBe(NOW - 4 * MIN);
    const done = feed(finishFeedData(f, NOW)!, 10);
    // Finished: 6 min fed plus 4 min paused must end by now.
    expect(latestStart(done, NOW)).toBe(NOW - 10 * MIN);
  });

  describe('an old "both" timer told its side keeps its pauses', () => {
    // Fed 4 min, paused 3 min; the side is picked at -7 (still paused) or after Resume.
    const legacy = () => feed({ side: 'both', durationSeconds: null }, 11);

    test('picked while paused: stays paused, and the pause stays out', () => {
      let f = feed(pauseFeedData(legacy(), NOW - 7 * MIN), 11);
      f = reload(feed(pickSideData(f, 'left'), 11));
      expect(isPaused(f)).toBe(true);
      expect(currentSide(f)).toBe('left');
      expect(sideTimes(f, NOW)).toEqual({ left: 4 * MIN, right: 0 });
      // The repro: Stop at -4 saves 240, not 420.
      expect(feed(finishFeedData(f, NOW - 4 * MIN)!, 11).data).toEqual({
        side: 'left',
        durationSeconds: 240,
        segments: [{ side: 'left', seconds: 240 }],
      });
      // Resume at -4, feed 4 more: 480, with the 3 min pause recorded.
      f = feed(resumeFeedData(f, NOW - 4 * MIN)!, 11);
      expect(feed(finishFeedData(f, NOW)!, 11).data).toEqual({
        side: 'left',
        durationSeconds: 480,
        segments: [{ side: 'left', seconds: 480 }],
        pausedSeconds: 180,
      });
    });

    test('picked after Resume: the finished pause stays out', () => {
      let f = feed(pauseFeedData(legacy(), NOW - 7 * MIN), 11);
      f = feed(resumeFeedData(f, NOW - 4 * MIN)!, 11);
      f = reload(feed(pickSideData(f, 'right'), 11));
      expect(f.data.pausedSeconds).toBe(180);
      expect(sideTimes(f, NOW)).toEqual({ left: 0, right: 8 * MIN });
      f = feed(switchFeedData(f, NOW - 2 * MIN)!, 11);
      expect(f.data.segments).toEqual([
        { side: 'right', seconds: 360 },
        { side: 'left', seconds: null },
      ]);
      expect(feed(finishFeedData(f, NOW)!, 11).data.durationSeconds).toBe(480);
    });

    test('a pause past 24 h on a picked feed still asks for the duration', () => {
      let f = feed({ side: 'both', durationSeconds: null }, 25 * 60);
      f = feed(pauseFeedData(f, NOW - (24 * 60 + 1) * MIN), 25 * 60);
      f = feed(pickSideData(f, 'left'), 25 * 60);
      expect(resumeFeedData(f, NOW)).toBeNull();
      expect(switchFeedData(f, NOW)).toBeNull();
      // Stopping ends at the pause: 59 min fed, no clamp.
      expect(feed(finishFeedData(f, NOW)!, 25 * 60).data.durationSeconds).toBe(59 * 60);
    });
  });

  test('describe says paused', () => {
    const f = feed(pauseFeedData(feed(startFeedData('left'), 3), NOW), 3);
    expect(describeEvent(f, String)).toBe('Breastfeed · left · paused');
  });
});

describe('dial', () => {
  test('counts the last 24 hours only; a mixed diaper is wet and dirty; bottles are their own mark', () => {
    const events = [
      ev('diaper', { kind: 'wet' }, 10),
      ev('diaper', { kind: 'mixed', stool: null }, 20),
      ev('diaper', { kind: 'dirty', stool: null }, 30),
      ev('bottle', { contents: 'formula', volumeMl: 60 }, 40),
      ev('breastfeed', { side: 'left', durationSeconds: 600 }, 50),
      ev('diaper', { kind: 'wet' }, 24 * 60), // exactly 24 h ago: outside
      ev('diaper', { kind: 'wet' }, -5), // future: outside
    ];
    expect(countMarks(dayMarks(events, NOW))).toEqual({
      feed: 1,
      bottle: 1,
      wet: 2,
      dirty: 2,
      pump: 0,
    });
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

describe('caption fit (#34)', () => {
  test('the caption radius stays clear of every inner mark, square corners included', () => {
    // Inner marks sit on r=99: wet dots of r 5.5, dirty squares 11 wide (corner at 5.5√2).
    const nearestMark = 99 - 5.5 * Math.SQRT2;
    expect(CAPTION_RADIUS).toBeLessThan(nearestMark);
    expect(nearestMark - CAPTION_RADIUS).toBeCloseTo(4);
  });

  test('a row is bounded by its corner farthest from the centre', () => {
    // A 3-4-5 triangle: an edge 3 from the centre of a radius-5 circle leaves a chord of 8.
    expect(chordWidth(5, -3, -1)).toBeCloseTo(8);
    expect(chordWidth(5, 1, 3)).toBeCloseTo(8);
    // A row straddling the centre gets the full diameter.
    expect(chordWidth(5, -1, 1)).toBeCloseTo(2 * Math.sqrt(24));
    // Every corner of a row exactly as wide as its chord lies on or inside the circle.
    const rows: [number, number][] = [
      [-60, -40],
      [-10, 12],
      [30, 70],
    ];
    for (const [top, bottom] of rows) {
      const half = chordWidth(80, top, bottom) / 2;
      for (const y of [top, bottom]) expect(Math.hypot(half, y)).toBeLessThanOrEqual(80 + 1e-9);
    }
  });

  test('a row touching or past the circle gets no width', () => {
    expect(chordWidth(5, 2, 5)).toBe(0);
    expect(chordWidth(5, -7, -6)).toBe(0);
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

  test('a write refused during sign-out points to Settings', () => {
    expect(saveFailure(new SigningOut())).toMatch(/signs out\. Finish or cancel sign-out/);
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

test('kindName names an entry without its details (#49)', () => {
  const stool = { color: 'pale_yellow', consistency: null, size: null, flags: [] };
  expect(
    [
      ev('diaper', { kind: 'wet' }, 0),
      ev('diaper', { kind: 'mixed', stool }, 0),
      ev('bottle', { contents: 'breast_milk', volumeMl: 240 }, 0),
      ev('breastfeed', { side: 'left', durationSeconds: null }, 3),
      ev('pump', { side: 'both', durationSeconds: 900, leftMl: 60, rightMl: 45 }, 15),
      ev('weight', { grams: 4535 }, 0),
    ].map(kindName),
  ).toEqual(['Wet diaper', 'Mixed diaper', 'Bottle', 'Breastfeed', 'Pump', 'Weight']);
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

describe('pump timer (#22)', () => {
  const pumpEv = (data: unknown, minutesAgo: number) => ev('pump', data, minutesAgo) as Pump;
  const valid = (e: BabyEvent) => expect(parseEvent(e)).toMatchObject({ ok: true });

  test('start, then stop after closing the tab: the saved event validates with the real duration', () => {
    const running = pumpEv(startPumpData('both'), 0);
    valid(running);
    expect(runningPump([running])?.id).toBe(running.id);
    // Reopened 25 minutes later: the duration comes from the stored start, not a page timer.
    const seconds = stopSeconds(running.occurredAt, Date.parse(running.occurredAt) + 25 * 60_000);
    expect(seconds).toBe(1500);
    const done = { ...running, data: pumpData('both', { left: 50, right: 0 }, true, seconds!) };
    valid(done);
    expect(runningPump([done])).toBeUndefined();
    expect(lastPump([done])?.id).toBe(done.id);
    expect(describeEvent(done, (ml) => `${ml} mL`)).toBe('Pump · left 50 mL · right 0 mL');
  });

  test('a long pump is not clamped below the schema bound; past it, nothing is computed', () => {
    const start = '2026-10-29T08:00:00.000Z';
    expect(stopSeconds(start, Date.parse(start) + MAX_FEED_SECONDS * 1000)).toBe(MAX_FEED_SECONDS);
    expect(stopSeconds(start, Date.parse(start) + MAX_FEED_SECONDS * 1000 + 1000)).toBeNull();
  });

  test('only the sides pumped get a volume', () => {
    expect(pumpData('left', { left: 40, right: 70 }, false, 60)).toMatchObject({
      leftMl: 40,
      rightMl: null,
      side: 'left',
    });
    expect(pumpData('right', { left: 40, right: 70 }, false)).toEqual({
      leftMl: null,
      rightMl: 70,
      afterFeed: false,
      side: 'right',
    });
    valid(pumpEv(pumpData('right', { left: 40, right: 70 }, false), 10));
  });

  test('side comes from the timer, or from the volumes on pumps from before it', () => {
    expect(pumpSide(pumpEv(pumpData('both', { left: 0, right: 0 }, true, 60), 1))).toBe('both');
    expect(pumpSide(pumpEv({ leftMl: null, rightMl: 30, afterFeed: false }, 1))).toBe('right');
    expect(pumpSide(pumpEv({ leftMl: 30, rightMl: 30, afterFeed: false }, 1))).toBe('both');
  });

  test('"right after a feed" when a feed ended within 30 minutes before the start', () => {
    const start = NOW;
    // A 20-minute feed that started 50 minutes ago ended 30 minutes ago: counts.
    expect(
      followsFeed([ev('breastfeed', { side: 'left', durationSeconds: 1200 }, 50)], start),
    ).toBe(true);
    expect(
      followsFeed([ev('breastfeed', { side: 'left', durationSeconds: 1200 }, 51)], start),
    ).toBe(false);
    expect(followsFeed([ev('bottle', { contents: 'formula', volumeMl: 60 }, 10)], start)).toBe(
      true,
    );
    // A running feed has not ended, a deleted one never happened, a later one is not before.
    expect(followsFeed([ev('breastfeed', { side: 'left', durationSeconds: null }, 5)], start)).toBe(
      false,
    );
    expect(
      followsFeed(
        [{ ...ev('bottle', { contents: 'formula', volumeMl: 60 }, 5), deleted: true }],
        start,
      ),
    ).toBe(false);
    expect(followsFeed([ev('bottle', { contents: 'formula', volumeMl: 60 }, -1)], start)).toBe(
      false,
    );
  });

  test('each side starts at its own last volume, skipping running pumps', () => {
    const events = [
      pumpEv(startPumpData('left'), 1),
      pumpEv(pumpData('right', { left: 0, right: 45 }, false, 600), 60),
      pumpEv(pumpData('left', { left: 80, right: 0 }, false, 600), 120),
    ];
    expect(lastPumpMl(events, 'right')).toBe(45);
    expect(lastPumpMl(events, 'left')).toBe(80);
    expect(lastPumpMl([], 'left')).toBe(60);
  });

  test('volumes round-trip between mL and oz on the snapped scale', () => {
    for (let ml = 0; ml <= 240; ml += 5) {
      const oz = snapBottle(ml, 'oz');
      expect(snapBottle(oz, 'oz')).toBe(oz);
      expect(snapBottle(snapBottle(ml, 'ml'), 'ml')).toBe(ml);
    }
    expect(snapBottle(toMl(2.5, 'oz'), 'oz')).toBe(toMl(2.5, 'oz'));
  });

  test('a running pump reopens its timer; a finished one keeps ending by now', () => {
    expect(editLink(pumpEv(startPumpData('left'), 3))?.path).toBe('/pump');
    const done = pumpEv(pumpData('left', { left: 40, right: 0 }, false, 900), 20);
    expect(editLink(done)?.path).toBe(`/logged?id=${done.id}`);
    expect(latestStart(done, NOW)).toBe(NOW - 900_000);
    expect(latestStart(pumpEv({ leftMl: 4, rightMl: null, afterFeed: false }, 5), NOW)).toBe(
      undefined,
    );
  });

  test('Stop saves "stopped, amount not entered" (#32): valid, not running, not the last pump', () => {
    const before = pumpEv(pumpData('left', { left: 80, right: 0 }, false, 600), 120);
    const stopped = pumpEv(stopPumpData('both', 1500), 30);
    valid(stopped);
    const events = [stopped, before];
    expect(runningPump(events)).toBeUndefined();
    expect(stoppedPump(events)?.id).toBe(stopped.id);
    // Home and the next pump's defaults follow the last pump with an amount.
    expect(lastPump(events)?.id).toBe(before.id);
    expect(lastPumpMl(events, 'left')).toBe(80);
    expect(describeEvent(stopped, (ml) => `${ml} mL`)).toBe('Pump · both · 25 min · add amount');
    expect(editLink(stopped)).toBeUndefined();
    expect(latestStart(stopped, NOW)).toBe(NOW - 1_500_000);
    // Running and finished pumps are never "stopped"; nor is an old pump with a 0 mL side.
    expect(stoppedPump([pumpEv(startPumpData('left'), 1)])).toBeUndefined();
    expect(stoppedPump([before])).toBeUndefined();
    expect(stoppedPump([pumpEv({ leftMl: 0, rightMl: null, afterFeed: true }, 1)])).toBeUndefined();
  });
});
