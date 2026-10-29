import { describe, expect, test } from 'vitest';
import { minutesBefore, readPick, time, toLocalInput, when } from './time.ts';

// Local wall times, so the expectations hold in any zone the suite runs in.
const NOW = new Date(2026, 9, 29, 1, 40, 30).getTime();
const local = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();

describe('when', () => {
  test('today is just the time', () => {
    expect(when(local(29, 0, 5), NOW)).toBe(time(local(29, 0, 5)));
  });
  test('across midnight it says Yesterday', () => {
    expect(when(local(28, 23, 40), NOW)).toBe(`Yesterday ${time(local(28, 23, 40))}`);
  });
  test('older times carry the date', () => {
    const t = local(27, 23, 40);
    expect(when(t, NOW)).not.toMatch(/Yesterday/);
    expect(when(t, NOW)).toContain(time(t));
    expect(when(t, NOW)).toContain('27');
  });
});

test('quick offsets count back from now', () => {
  expect(Date.parse(minutesBefore(NOW, 30))).toBe(NOW - 30 * 60_000);
});

describe('readPick', () => {
  test('a past minute is that time', () => {
    expect(readPick(toLocalInput(local(29, 0, 20)), NOW)).toBe(
      new Date(local(29, 0, 20)).toISOString(),
    );
  });
  test('the current minute means now', () => {
    expect(readPick(toLocalInput(NOW), NOW)).toBeNull();
  });
  test('a future time changes nothing (iOS ignores max)', () => {
    expect(readPick(toLocalInput(local(29, 2, 0)), NOW)).toBeUndefined();
  });
  test('empty or malformed changes nothing', () => {
    expect(readPick('', NOW)).toBeUndefined();
    expect(readPick('2026-10-29', NOW)).toBeUndefined();
  });
  test('a cap before now rules out now and anything after the cap', () => {
    const latest = NOW - 20 * 60_000; // a 20-minute feed must have started by 1:20
    expect(readPick(toLocalInput(NOW), NOW, latest)).toBeUndefined();
    expect(readPick(toLocalInput(local(29, 1, 25)), NOW, latest)).toBeUndefined();
    expect(readPick(toLocalInput(local(29, 1, 0)), NOW, latest)).toBe(
      new Date(local(29, 1, 0)).toISOString(),
    );
  });
});
