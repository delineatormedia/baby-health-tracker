import { newId, toMl, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  ageDays,
  clock,
  countMarks,
  dayMarks,
  describe as describeEvent,
  hm,
  intake24h,
  lastSide,
  MAX_FEED_SECONDS,
  polar,
  runningFeed,
  saveFailure,
  snapBottle,
  stepBottle,
  stopSeconds,
  suggestSide,
  typedSide,
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
