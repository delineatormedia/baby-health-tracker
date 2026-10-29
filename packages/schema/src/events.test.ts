import { describe, expect, test } from 'vitest';
import {
  EVENT_TYPES,
  nextVersion,
  parseEvent,
  weightedFeedIntakeMl,
  type EventType,
} from './events.ts';
import { newId } from './model.ts';
import { toMl } from './units.ts';

function event(type: EventType, data: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    babyId: newId(),
    authorId: newId(),
    occurredAt: '2026-10-29T03:00:00.000Z',
    recordedAt: '2026-10-29T03:00:05.000Z',
    version: 1,
    deleted: false,
    notes: null,
    type,
    data,
    ...overrides,
  };
}

function expectValid(input: unknown) {
  const r = parseEvent(input);
  if (!r.ok) throw new Error(`expected valid, got: ${r.errors.join('; ')}`);
  return r.value;
}

function expectInvalid(input: unknown, pattern?: RegExp) {
  const r = parseEvent(input);
  expect(r.ok).toBe(false);
  if (!r.ok && pattern) expect(r.errors.join('\n')).toMatch(pattern);
}

const validData: Record<EventType, unknown> = {
  breastfeed: { side: 'left', durationSeconds: 900 },
  bottle: { contents: 'formula', volumeMl: toMl(3, 'oz') },
  diaper: { kind: 'wet' },
  pump: { leftMl: 40, rightMl: 35, afterFeed: false },
  weight: { grams: 3450, source: 'clinic' },
  weighted_feed: { beforeGrams: 3450, afterGrams: 3512, side: 'right' },
  missed_logs: { start: '2026-10-28T03:00:00.000Z', end: '2026-10-29T03:00:00.000Z' },
};

describe('envelope', () => {
  test('every event type has a valid example', () => {
    expect(Object.keys(validData).sort()).toEqual([...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) expectValid(event(type, validData[type]));
  });

  test('accepts edits, tombstones and notes', () => {
    expectValid(event('diaper', { kind: 'wet' }, { version: 3, deleted: true, notes: 'leaked' }));
  });

  test.each([
    ['unknown type', { type: 'sleep' }],
    ['bad id', { id: 'not-a-ulid' }],
    ['missing babyId', { babyId: undefined }],
    ['local timestamp', { occurredAt: '2026-10-29T03:00:00' }],
    ['version 0', { version: 0 }],
    ['fractional version', { version: 1.5 }],
    ['version past MAX_SAFE_INTEGER', { version: Number.MAX_SAFE_INTEGER + 1 }],
    ['version 1e100', { version: 1e100 }],
    ['deleted as string', { deleted: 'false' }],
    ['notes too long', { notes: 'x'.repeat(2001) }],
    ['unknown key', { extra: true }],
  ])('rejects %s', (_, overrides) => {
    expectInvalid(event('diaper', { kind: 'wet' }, overrides));
  });

  test('accepts the largest safe version', () => {
    expectValid(event('diaper', { kind: 'wet' }, { version: Number.MAX_SAFE_INTEGER }));
  });

  test('nextVersion increments and refuses to overflow', () => {
    expect(nextVersion(1)).toBe(2);
    expect(nextVersion(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => nextVersion(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => nextVersion(0)).toThrow(RangeError);
    expect(() => nextVersion(1.5)).toThrow(RangeError);
  });

  test('rejects non-objects', () => {
    for (const input of [null, undefined, 42, 'diaper', []]) expectInvalid(input);
  });

  test('error messages carry the path', () => {
    expectInvalid(event('bottle', { contents: 'formula', volumeMl: -5 }), /data\.volumeMl/);
  });
});

describe('breastfeed', () => {
  test('a running timer has a null duration', () => {
    expectValid(event('breastfeed', { side: 'both', durationSeconds: null }));
  });

  test.each([
    { side: 'middle', durationSeconds: 60 },
    { side: 'left', durationSeconds: 0 },
    { side: 'left', durationSeconds: 90.5 },
    { side: 'left', durationSeconds: 5 * 60 * 60 },
    { side: 'left' },
  ])('rejects %j', (data) => {
    expectInvalid(event('breastfeed', data));
  });

  test('a timer on one side has one open segment', () => {
    expectValid(
      event('breastfeed', {
        side: 'left',
        durationSeconds: null,
        segments: [{ side: 'left', seconds: null }],
      }),
    );
  });

  test('a switch keeps the first side and runs on the second', () => {
    expectValid(
      event('breastfeed', {
        side: 'both',
        durationSeconds: null,
        segments: [
          { side: 'left', seconds: 480 },
          { side: 'right', seconds: null },
        ],
      }),
    );
  });

  test('a finished switched feed keeps both durations', () => {
    const e = expectValid(
      event('breastfeed', {
        side: 'both',
        durationSeconds: 840,
        segments: [
          { side: 'left', seconds: 480 },
          { side: 'right', seconds: 360 },
        ],
      }),
    );
    expect(e.data).toMatchObject({ segments: [{ seconds: 480 }, { seconds: 360 }] });
  });

  test('feeds without segments stay valid', () => {
    expectValid(event('breastfeed', { side: 'both', durationSeconds: 600 }));
  });

  test.each([
    ['an empty list', { side: 'left', durationSeconds: null, segments: [] }],
    [
      'an open segment before the last',
      {
        side: 'both',
        durationSeconds: null,
        segments: [
          { side: 'left', seconds: null },
          { side: 'right', seconds: null },
        ],
      },
    ],
    [
      'a finished feed with an open segment',
      { side: 'left', durationSeconds: 60, segments: [{ side: 'left', seconds: null }] },
    ],
    [
      'a running feed with every segment closed',
      { side: 'left', durationSeconds: null, segments: [{ side: 'left', seconds: 60 }] },
    ],
    [
      'the same side twice in a row',
      {
        side: 'left',
        durationSeconds: 120,
        segments: [
          { side: 'left', seconds: 60 },
          { side: 'left', seconds: 60 },
        ],
      },
    ],
    [
      'a side that disagrees with the segments',
      { side: 'right', durationSeconds: 60, segments: [{ side: 'left', seconds: 60 }] },
    ],
    [
      'a switched feed not marked both',
      {
        side: 'left',
        durationSeconds: 120,
        segments: [
          { side: 'left', seconds: 60 },
          { side: 'right', seconds: 60 },
        ],
      },
    ],
    [
      'segments that do not add up',
      {
        side: 'both',
        durationSeconds: 900,
        segments: [
          { side: 'left', seconds: 480 },
          { side: 'right', seconds: 360 },
        ],
      },
    ],
    [
      'a both segment',
      { side: 'both', durationSeconds: 60, segments: [{ side: 'both', seconds: 60 }] },
    ],
    [
      'a negative segment',
      {
        side: 'both',
        durationSeconds: null,
        segments: [
          { side: 'left', seconds: -1 },
          { side: 'right', seconds: null },
        ],
      },
    ],
  ])('rejects %s', (_, data) => {
    expectInvalid(event('breastfeed', data));
  });
});

describe('bottle', () => {
  test('accepts breast milk', () => {
    expectValid(event('bottle', { contents: 'breast_milk', volumeMl: 60 }));
  });

  test.each([
    { contents: 'juice', volumeMl: 60 },
    { contents: 'formula', volumeMl: 0 },
    { contents: 'formula', volumeMl: 5000 },
    { contents: 'formula', volumeMl: Number.NaN },
    { contents: 'formula', volumeMl: '60' },
    { contents: 'formula' },
  ])('rejects %j', (data) => {
    expectInvalid(event('bottle', data));
  });
});

describe('diaper', () => {
  test('dirty with full stool details', () => {
    expectValid(
      event('diaper', {
        kind: 'dirty',
        stool: { color: 'mustard', consistency: 'seedy', size: 'medium', flags: [] },
      }),
    );
  });

  test('mixed with the red-flag colors and flags', () => {
    for (const color of ['pale_yellow', 'clay', 'white']) {
      expectValid(
        event('diaper', {
          kind: 'mixed',
          stool: { color, consistency: null, size: 'large', flags: ['mucus', 'blood'] },
        }),
      );
    }
  });

  test('dirty without details (two-tap log)', () => {
    expectValid(event('diaper', { kind: 'dirty', stool: null }));
  });

  test.each([
    { kind: 'damp' },
    { kind: 'wet', stool: null },
    { kind: 'dirty' },
    { kind: 'dirty', stool: { color: 'purple', consistency: null, size: null, flags: [] } },
    { kind: 'dirty', stool: { color: null, consistency: 'chunky', size: null, flags: [] } },
    { kind: 'dirty', stool: { color: null, consistency: null, size: 'huge', flags: [] } },
    { kind: 'dirty', stool: { color: null, consistency: null, size: null, flags: ['worms'] } },
    {
      kind: 'dirty',
      stool: { color: null, consistency: null, size: null, flags: ['blood', 'blood'] },
    },
  ])('rejects %j', (data) => {
    expectInvalid(event('diaper', data));
  });
});

describe('pump', () => {
  test('one side, and an empty pump after a feed', () => {
    expectValid(event('pump', { leftMl: 60, rightMl: null, afterFeed: false }));
    expectValid(event('pump', { leftMl: 0, rightMl: 0, afterFeed: true }));
  });

  test.each([
    { leftMl: null, rightMl: null, afterFeed: false },
    { leftMl: -1, rightMl: null, afterFeed: false },
    { leftMl: 600, rightMl: null, afterFeed: false },
    { leftMl: 40, rightMl: 40 },
  ])('rejects %j', (data) => {
    expectInvalid(event('pump', data));
  });

  test('timer: running with no volumes, then finished with the sides it ran on', () => {
    expectValid(
      event('pump', {
        leftMl: null,
        rightMl: null,
        afterFeed: false,
        side: 'both',
        durationSeconds: null,
      }),
    );
    expectValid(
      event('pump', {
        leftMl: 50,
        rightMl: 0,
        afterFeed: true,
        side: 'both',
        durationSeconds: 900,
      }),
    );
    expectValid(
      event('pump', {
        leftMl: null,
        rightMl: 30,
        afterFeed: false,
        side: 'right',
        durationSeconds: 1,
      }),
    );
    expectValid(
      event('pump', {
        leftMl: 30,
        rightMl: null,
        afterFeed: false,
        side: 'left',
        durationSeconds: 14_400,
      }),
    );
  });

  test.each([
    [
      'running without a side',
      { leftMl: null, rightMl: null, afterFeed: false, durationSeconds: null },
    ],
    [
      'running with a volume',
      { leftMl: 20, rightMl: null, afterFeed: false, side: 'left', durationSeconds: null },
    ],
    [
      'both sides, one volume',
      { leftMl: 20, rightMl: null, afterFeed: false, side: 'both', durationSeconds: 600 },
    ],
    [
      'left side, right volume',
      { leftMl: null, rightMl: 20, afterFeed: false, side: 'left', durationSeconds: 600 },
    ],
    [
      'left side, both volumes',
      { leftMl: 20, rightMl: 20, afterFeed: false, side: 'left', durationSeconds: 600 },
    ],
    [
      'finished with no volume',
      { leftMl: null, rightMl: null, afterFeed: false, side: 'left', durationSeconds: 600 },
    ],
    [
      'zero seconds',
      { leftMl: 20, rightMl: null, afterFeed: false, side: 'left', durationSeconds: 0 },
    ],
    [
      'past 4 hours',
      { leftMl: 20, rightMl: null, afterFeed: false, side: 'left', durationSeconds: 14_401 },
    ],
    [
      'fractional seconds',
      { leftMl: 20, rightMl: null, afterFeed: false, side: 'left', durationSeconds: 1.5 },
    ],
    [
      'unknown side',
      { leftMl: 20, rightMl: null, afterFeed: false, side: 'middle', durationSeconds: 60 },
    ],
  ])('rejects %s', (_, data) => {
    expectInvalid(event('pump', data));
  });
});

describe('weight', () => {
  test('home scale', () => {
    expectValid(event('weight', { grams: 4100, source: 'home' }));
  });

  test.each([
    { grams: 3450, source: 'guess' },
    { grams: 34500, source: 'clinic' },
    { grams: 34.5, source: 'clinic' },
    { grams: 3450 },
  ])('rejects %j', (data) => {
    expectInvalid(event('weight', data));
  });
});

describe('weighted feed', () => {
  test('intake is the weight gained', () => {
    const e = expectValid(event('weighted_feed', validData.weighted_feed));
    expect(e.type === 'weighted_feed' && weightedFeedIntakeMl(e.data)).toBe(62);
  });

  test('allows a loss (the baby voided between weighings)', () => {
    expectValid(event('weighted_feed', { beforeGrams: 3500, afterGrams: 3490, side: null }));
  });

  test.each([
    { beforeGrams: 3450, afterGrams: 3512 },
    { beforeGrams: 0, afterGrams: 3512, side: null },
    { beforeGrams: 3450, afterGrams: 35120, side: null },
  ])('rejects %j', (data) => {
    expectInvalid(event('weighted_feed', data));
  });
});

describe('missed_logs', () => {
  test.each([
    { start: '2026-10-29T03:00:00.000Z', end: '2026-10-29T03:00:00.000Z' },
    { start: '2026-10-29T03:00:00.000Z', end: '2026-10-28T03:00:00.000Z' },
    { start: 'yesterday', end: '2026-10-29T03:00:00.000Z' },
    { start: '2026-10-28T03:00:00.000Z' },
  ])('rejects %j', (data) => {
    expectInvalid(event('missed_logs', data));
  });
});
