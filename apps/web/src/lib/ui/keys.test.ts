import { newId, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { keyLines, keyName, since, type KeyLine } from './keys.ts';
import { time } from './time.ts';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const baby = newId();
const mL = (ml: number) => `${ml} mL`;

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

const text = (lines: readonly KeyLine[]) => lines.map((l) => `${l.em}${l.rest}`);
const at = (minutesAgo: number) => `at ${time(NOW - minutesAgo * 60_000)}`;

describe('time since', () => {
  test('just now, minutes, hours and minutes, then the date', () => {
    const t = (ms: number) => {
      const l = since(NOW - ms, NOW);
      return `${l.em}${l.rest}`;
    };
    expect(t(0)).toBe('Just now');
    expect(t(59_999)).toBe('Just now');
    expect(t(60_000)).toBe('1m ago');
    expect(t(54 * 60_000)).toBe('54m ago');
    expect(t(60 * 60_000)).toBe('1h 0m ago');
    expect(t(190 * 60_000)).toBe('3h 10m ago');
    expect(t(24 * 3_600_000 - 1)).toBe('23h 59m ago');
    expect(t(24 * 3_600_000)).toMatch(/^Oct 28$|^28 Oct$/);
  });

  test('a time in the future (another phone ahead) reads Just now, never negative', () => {
    expect(since(NOW + 90_000, NOW).em).toBe('Just now');
  });
});

describe('key lines', () => {
  test('nothing logged', () => {
    const lines = keyLines([], NOW, mL);
    for (const k of ['feed', 'wet', 'dirty', 'bottle', 'pump'] as const)
      expect(text(lines[k])).toEqual(['Not logged yet']);
  });

  test('each key reads its own last event, newest first', () => {
    const events = [
      ev('diaper', { kind: 'wet' }, 54),
      ev('bottle', { volumeMl: 60, contents: 'breast_milk' }, 170),
      ev('diaper', { kind: 'dirty', color: 'mustard' }, 190),
      ev('pump', { leftMl: 45, rightMl: 38, afterFeed: false }, 304),
      ev('breastfeed', { side: 'left', durationSeconds: 900 }, 79),
      ev('breastfeed', { side: 'right', durationSeconds: 600 }, 400),
    ];
    const lines = keyLines(events, NOW, mL);
    expect(text(lines.feed)).toEqual(['1h 19m ago', at(79), 'Left side']);
    expect(text(lines.wet)).toEqual(['54m ago', at(54)]);
    expect(text(lines.dirty)).toEqual(['3h 10m ago', at(190)]);
    expect(text(lines.bottle)).toEqual(['2h 50m ago', '60 mL']);
    expect(text(lines.pump)).toEqual(['5h 4m ago', 'Both sides']);
  });

  test('a mixed diaper counts for Wet and for Dirty', () => {
    const lines = keyLines([ev('diaper', { kind: 'mixed', color: 'mustard' }, 5)], NOW, mL);
    expect(text(lines.wet)).toEqual(['5m ago', at(5)]);
    expect(text(lines.dirty)).toEqual(['5m ago', at(5)]);
  });

  test('a running feed is not the last feed; a switched feed reads Both sides', () => {
    const events = [
      ev('breastfeed', { side: 'right', durationSeconds: null }, 9),
      ev(
        'breastfeed',
        {
          side: 'both',
          durationSeconds: 1200,
          segments: [
            { side: 'left', seconds: 600 },
            { side: 'right', seconds: 600 },
          ],
        },
        120,
      ),
    ];
    expect(text(keyLines(events, NOW, mL).feed)).toEqual(['2h 0m ago', at(120), 'Both sides']);
  });

  test('a test weighing is not a feed, and a one-sided pump names its side', () => {
    const events = [
      ev('weighted_feed', { beforeGrams: 3600, afterGrams: 3640, side: 'left' }, 2),
      ev('pump', { leftMl: null, rightMl: 70, afterFeed: true }, 30),
    ];
    const lines = keyLines(events, NOW, mL);
    expect(text(lines.feed)).toEqual(['Not logged yet']);
    expect(text(lines.pump)).toEqual(['30m ago', 'Right side']);
  });

  test('the lines follow the event list, so an Undo takes the event back out', () => {
    const older = ev('diaper', { kind: 'wet' }, 54);
    const logged = ev('diaper', { kind: 'wet' }, 0);
    expect(text(keyLines([logged, older], NOW, mL).wet)[0]).toBe('Just now');
    expect(text(keyLines([older], NOW, mL).wet)[0]).toBe('54m ago');
  });

  test('bottle amounts use the volume setting', () => {
    const events = [ev('bottle', { volumeMl: 60, contents: 'formula' }, 1)];
    expect(text(keyLines(events, NOW, () => '2 oz').bottle)).toEqual(['1m ago', '2 oz']);
  });

  test('the accessible name reads the label and every line', () => {
    expect(
      keyName('Wet', [
        { em: '54m', rest: ' ago' },
        { em: '', rest: 'at 2:05 AM' },
      ]),
    ).toBe('Wet, 54m ago, at 2:05 AM');
  });
});
