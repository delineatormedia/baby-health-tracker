import { newId, type BabyEvent } from '@bht/schema';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ARC_WIDTH,
  BURST_MS,
  dialFace,
  INNER_STEP,
  LABEL_STEP,
  placeInner,
  RING,
  unitsToHours,
  type Point,
} from './dial.ts';
import { countMarks, dayMarks } from './logic.ts';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const MIN = 60_000;
const baby = newId();

function at(type: BabyEvent['type'], data: unknown, t: number): BabyEvent {
  const iso = new Date(t).toISOString();
  return {
    id: newId(),
    babyId: baby,
    authorId: baby,
    occurredAt: iso,
    recordedAt: iso,
    version: 1,
    deleted: false,
    notes: null,
    type,
    data,
  } as BabyEvent;
}
const ago = (type: BabyEvent['type'], data: unknown, minutes: number, now = NOW) =>
  at(type, data, now - minutes * MIN);

const hourOf = (ms: number) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
};
/** Local wall-clock time on the day of NOW, so tests read the same in every time zone. */
const local = (h: number, m = 0, s = 0) => {
  const d = new Date(NOW);
  d.setHours(h, m, s, 0);
  return d.getTime();
};
const WET = { kind: 'wet' };
const DIRTY = { kind: 'dirty', stool: null };
const of = (pts: Point[], kind: Point['kind']) => pts.filter((p) => p.kind === kind);

describe('bursts (#51)', () => {
  test('3 taps within 2 minutes are one mark at the first tap, counted ×3', () => {
    const events = [ago('diaper', WET, 30), ago('diaper', WET, 29), ago('diaper', WET, 28.5)];
    const face = dialFace(events, NOW);
    const wet = of(face.points, 'wet');
    expect(wet).toHaveLength(1);
    expect(wet[0]!.count).toBe(3);
    expect(wet[0]!.at).toBeCloseTo(hourOf(NOW - 30 * MIN));
    expect(face.labels.map((l) => l.text)).toEqual(['×3']);
    // The legend still counts every entry.
    expect(countMarks(dayMarks(events, NOW)).wet).toBe(3);
  });

  test('the window is measured from the first tap: exactly 2 minutes joins, 2:01 does not', () => {
    const first = NOW - 30 * MIN;
    const joined = dialFace([at('diaper', WET, first), at('diaper', WET, first + BURST_MS)], NOW);
    expect(of(joined.points, 'wet').map((p) => p.count)).toEqual([2]);
    const apart = dialFace(
      [at('diaper', WET, first), at('diaper', WET, first + BURST_MS + 1000)],
      NOW,
    );
    expect(of(apart.points, 'wet').map((p) => p.count)).toEqual([1, 1]);
    expect(apart.labels).toEqual([]);
    // A chain of taps a minute apart does not grow the burst past its first tap's window.
    const chain = dialFace(
      [0, 1, 2, 3].map((m) => at('diaper', WET, first + m * MIN)),
      NOW,
    );
    expect(of(chain.points, 'wet').map((p) => p.count)).toEqual([3, 1]);
  });

  test('a burst across midnight stays one mark', () => {
    const midnight = local(0);
    const now = midnight + 60 * MIN;
    const face = dialFace(
      [at('diaper', DIRTY, midnight - 30_000), at('diaper', DIRTY, midnight + 30_000)],
      now,
    );
    const dirty = of(face.points, 'dirty');
    expect(dirty).toHaveLength(1);
    expect(dirty[0]!.count).toBe(2);
    expect(dirty[0]!.at).toBeCloseTo(hourOf(midnight - 30_000));
  });

  test('wet and dirty bursts at the same time stay two marks side by side, counts apart', () => {
    const t = NOW - 60 * MIN;
    const events = [
      at('diaper', { kind: 'mixed', stool: null }, t),
      at('diaper', { kind: 'mixed', stool: null }, t + MIN),
      at('diaper', WET, t + 1.5 * MIN),
    ];
    const face = dialFace(events, NOW);
    const [wet] = of(face.points, 'wet');
    const [dirty] = of(face.points, 'dirty');
    expect([wet!.count, dirty!.count]).toEqual([3, 2]);
    expect(dirty!.at - wet!.at).toBeCloseTo(INNER_STEP);
    expect((wet!.at + dirty!.at) / 2).toBeCloseTo(hourOf(t));
    const [a, b] = face.labels.map((l) => l.at);
    expect(Math.abs(a! - b!)).toBeCloseTo(LABEL_STEP);
  });

  test('marks of one kind never move, even when they overlap', () => {
    const face = dialFace([ago('diaper', WET, 30), ago('diaper', WET, 20)], NOW);
    for (const p of face.points) expect(p.at).toBe(p.hour);
  });

  test('a mixed diaper is a wet and a dirty side by side, centred on its time', () => {
    const face = dialFace([ago('diaper', { kind: 'mixed', stool: null }, 30)], NOW);
    const [wet] = of(face.points, 'wet');
    const [dirty] = of(face.points, 'dirty');
    expect(dirty!.at - wet!.at).toBeCloseTo(INNER_STEP);
    expect((wet!.at + dirty!.at) / 2).toBeCloseTo(hourOf(NOW - 30 * MIN));
  });

  test('a wet and a dirty either side of midnight spread across it', () => {
    const placed = placeInner([
      { hour: 23.99, kind: 'wet', count: 1 },
      { hour: 0.01, kind: 'dirty', count: 1 },
    ]);
    const [a, b] = placed.map((p) => p.at);
    const gap = Math.min(Math.abs(a! - b!), 24 - Math.abs(a! - b!));
    expect(gap).toBeCloseTo(INNER_STEP);
    expect(placed.every((p) => p.at >= 0 && p.at < 24)).toBe(true);
  });

  test('bottles and pumps logged without a timer burst the same way', () => {
    const bottle = { contents: 'formula', volumeMl: 60 };
    const pump = { leftMl: 30, rightMl: null, afterFeed: false };
    const face = dialFace(
      [
        ago('bottle', bottle, 30),
        ago('bottle', bottle, 29),
        ago('pump', pump, 90),
        ago('pump', pump, 89),
      ],
      NOW,
    );
    expect(of(face.points, 'bottle').map((p) => p.count)).toEqual([2]);
    expect(of(face.points, 'pump').map((p) => p.count)).toEqual([2]);
    expect(face.arcs).toEqual([]);
  });

  test('a count that would touch an hour numeral hides it; the others stay', () => {
    const t = local(6, 1);
    const face = dialFace([at('diaper', DIRTY, t), at('diaper', DIRTY, t + MIN)], t + 2 * 60 * MIN);
    expect(face.numerals).toEqual([0, 12, 18]);
    expect(dialFace([], NOW).numerals).toEqual([0, 6, 12, 18]);
  });
});

describe('session arcs (#52)', () => {
  const twoSides = {
    side: 'both',
    durationSeconds: 35 * 60,
    segments: [
      { side: 'left', seconds: 20 * 60 },
      { side: 'right', seconds: 15 * 60 },
    ],
  };

  test('a breastfeed spans start to end, with a gap where it switched sides', () => {
    const start = NOW - 60 * MIN;
    const [arc] = dialFace([at('breastfeed', twoSides, start)], NOW).arcs;
    expect(arc!.kind).toBe('feed');
    expect(arc!.from).toBeCloseTo(hourOf(start));
    expect(arc!.to - arc!.from).toBeCloseTo(35 / 60);
    expect(arc!.switches).toHaveLength(1);
    expect(arc!.switches[0]! - arc!.from).toBeCloseTo(20 / 60);
  });

  test('paused time lengthens the arc and moves the switch in proportion', () => {
    const start = NOW - 60 * MIN;
    const paused = { ...twoSides, pausedSeconds: 5 * 60 };
    const [arc] = dialFace([at('breastfeed', paused, start)], NOW).arcs;
    expect(arc!.to - arc!.from).toBeCloseTo(40 / 60);
    expect(arc!.switches[0]! - arc!.from).toBeCloseTo((20 / 60) * (40 / 35));
  });

  test('a one-side or typed feed has no gap', () => {
    const [arc] = dialFace(
      [ago('breastfeed', { side: 'left', durationSeconds: 600 }, 30)],
      NOW,
    ).arcs;
    expect(arc!.switches).toEqual([]);
  });

  test('a running feed grows to now, switch included', () => {
    const running = {
      side: 'both',
      durationSeconds: null,
      segments: [
        { side: 'left', seconds: 10 * 60 },
        { side: 'right', seconds: null },
      ],
    };
    const [arc] = dialFace([ago('breastfeed', running, 30)], NOW).arcs;
    expect(arc!.to).toBeCloseTo(hourOf(NOW - 30 * MIN) + 30 / 60);
    expect(arc!.switches[0]! - arc!.from).toBeCloseTo(10 / 60);
  });

  test('an arc is never shorter than its own width', () => {
    const [arc] = dialFace(
      [ago('breastfeed', { side: 'left', durationSeconds: 60 }, 30)],
      NOW,
    ).arcs;
    expect(arc!.to - arc!.from).toBeCloseTo(unitsToHours(ARC_WIDTH.feed, RING.feed));
  });

  test('pumps: timed ones are arcs (running, or stopped awaiting the amount); untimed ones are diamonds', () => {
    const events = [
      ago(
        'pump',
        { leftMl: null, rightMl: null, afterFeed: false, side: 'both', durationSeconds: null },
        10,
      ),
      ago(
        'pump',
        { leftMl: null, rightMl: null, afterFeed: false, side: 'left', durationSeconds: 900 },
        120,
      ),
      ago(
        'pump',
        { leftMl: 40, rightMl: 40, afterFeed: false, side: 'both', durationSeconds: 1200 },
        300,
      ),
      ago('pump', { leftMl: 40, rightMl: null, afterFeed: false }, 400),
    ];
    const face = dialFace(events, NOW);
    const spans = face.arcs.map((a) => Math.round((a.to - a.from) * 60));
    expect(face.arcs.every((a) => a.kind === 'pump' && a.switches.length === 0)).toBe(true);
    expect(spans).toEqual([20, 15, 10]);
    expect(of(face.points, 'pump')).toHaveLength(1);
    // Pump joins the legend, counted by start like every other kind.
    expect(countMarks(dayMarks(events, NOW)).pump).toBe(4);
  });

  test('longest first, so a shorter session draws on top', () => {
    const face = dialFace(
      [
        ago('breastfeed', { side: 'left', durationSeconds: 25 * 60 }, 100),
        ago('breastfeed', { side: 'right', durationSeconds: 60 * 60 }, 120),
      ],
      NOW,
    );
    expect(face.arcs.map((a) => Math.round((a.to - a.from) * 60))).toEqual([60, 25]);
  });

  test('sessions with the same start and end are one arc with a count', () => {
    const feed = { side: 'left', durationSeconds: 600 };
    const face = dialFace([ago('breastfeed', feed, 30), ago('breastfeed', feed, 29)], NOW);
    expect(face.arcs).toHaveLength(1);
    expect(face.arcs[0]!.count).toBe(2);
    expect(face.labels.map((l) => l.text)).toEqual(['×2']);
  });

  test('a session that began before the 24 hours is cut flat at the now line', () => {
    const face = dialFace(
      [ago('breastfeed', { side: 'left', durationSeconds: 30 * 60 }, 24 * 60 + 10)],
      NOW,
    );
    const [arc] = face.arcs;
    expect(arc!.cut).toBe(true);
    expect(arc!.from % 24).toBeCloseTo(face.now);
    expect(arc!.to - arc!.from).toBeCloseTo(20 / 60);
    // Ended before the 24 hours: not drawn.
    expect(
      dialFace([ago('breastfeed', { side: 'left', durationSeconds: 60 }, 24 * 60 + 10)], NOW).arcs,
    ).toEqual([]);
  });
});

describe('arcs across a DST change (America/New_York)', () => {
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = zone;
  });
  const t = Date.parse;
  const LEFT = { side: 'left', durationSeconds: null };
  const PUMP = { leftMl: null, rightMl: null, afterFeed: false, side: 'both' };
  const minWidth = unitsToHours(ARC_WIDTH.feed, RING.feed);

  test('spring forward: a running feed and pump reach the now line over the skipped hour', () => {
    const start = t('2026-03-08T01:30:00-05:00');
    const now = t('2026-03-08T03:30:00-04:00');
    for (const [type, data] of [
      ['breastfeed', LEFT],
      ['pump', { ...PUMP, durationSeconds: null }],
    ] as const) {
      const face = dialFace([at(type, data, start)], now);
      expect(face.now).toBeCloseTo(3.5);
      expect(face.arcs[0]!.from).toBeCloseTo(1.5);
      expect(face.arcs[0]!.to).toBeCloseTo(face.now);
    }
  });

  test('spring forward: a finished pump ends on its clock time', () => {
    // 01:40 EST + 50 min = 03:30 EDT.
    const start = t('2026-03-08T01:40:00-05:00');
    const [arc] = dialFace(
      [at('pump', { ...PUMP, durationSeconds: 50 * 60 }, start)],
      t('2026-03-08T06:00:00-04:00'),
    ).arcs;
    expect(arc!.from).toBeCloseTo(1 + 40 / 60);
    expect(arc!.to).toBeCloseTo(3.5);
  });

  test('fall back: a running feed reaches the now line, never a full circle', () => {
    const now = t('2026-11-01T01:20:00-05:00');
    const [long] = dialFace([at('breastfeed', LEFT, t('2026-11-01T00:50:00-04:00'))], now).arcs;
    expect(long!.from).toBeCloseTo(50 / 60);
    expect(long!.to).toBeCloseTo(1 + 20 / 60);
    // Started in the first 01:30, now the second: same clock time, an hour apart.
    const face = dialFace([at('breastfeed', LEFT, t('2026-11-01T01:30:00-04:00'))], now + 10 * MIN);
    expect(face.now).toBeCloseTo(1.5);
    expect(face.arcs[0]!.from).toBeCloseTo(1.5);
    expect(face.arcs[0]!.to - face.arcs[0]!.from).toBeCloseTo(minWidth);
  });

  test('fall back: a finished feed ends on its clock time, switch included', () => {
    // 00:20 EDT, 30 min left then 90 right: switch 00:50 EDT, end 01:20 EST.
    const feed = {
      side: 'both',
      durationSeconds: 120 * 60,
      segments: [
        { side: 'left', seconds: 30 * 60 },
        { side: 'right', seconds: 90 * 60 },
      ],
    };
    const [arc] = dialFace(
      [at('breastfeed', feed, t('2026-11-01T00:20:00-04:00'))],
      t('2026-11-01T06:00:00-05:00'),
    ).arcs;
    expect(arc!.from).toBeCloseTo(20 / 60);
    expect(arc!.switches).toHaveLength(1);
    expect(arc!.switches[0]!).toBeCloseTo(50 / 60);
    expect(arc!.to).toBeCloseTo(1 + 20 / 60);
    // Ending earlier on the clock than it started: drawn forward at its minimum width.
    const [back] = dialFace(
      [
        at(
          'breastfeed',
          { side: 'left', durationSeconds: 50 * 60 },
          t('2026-11-01T01:20:00-04:00'),
        ),
      ],
      t('2026-11-01T06:00:00-05:00'),
    ).arcs;
    expect(back!.from).toBeCloseTo(1 + 20 / 60);
    expect(back!.to - back!.from).toBeCloseTo(minWidth);
  });

  test('the 24-hour cut is elapsed time, drawn at its own clock time', () => {
    // 24 hours before 12:00 EDT is 11:00 EST: the window holds 23 clock hours.
    const spring = dialFace(
      [at('breastfeed', { side: 'left', durationSeconds: 3600 }, t('2026-03-07T10:30:00-05:00'))],
      t('2026-03-08T12:00:00-04:00'),
    );
    expect(spring.arcs[0]!.cut).toBe(true);
    expect(spring.arcs[0]!.from).toBeCloseTo(11);
    expect(spring.arcs[0]!.to).toBeCloseTo(11.5);
    // 24 hours before 12:00 EST is 13:00 EDT: 25 clock hours.
    const fall = dialFace(
      [at('breastfeed', { side: 'left', durationSeconds: 3600 }, t('2026-10-31T12:30:00-04:00'))],
      t('2026-11-01T12:00:00-05:00'),
    );
    expect(fall.arcs[0]!.cut).toBe(true);
    expect(fall.arcs[0]!.from).toBeCloseTo(13);
    expect(fall.arcs[0]!.to).toBeCloseTo(13.5);
  });
});
