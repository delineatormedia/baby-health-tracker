import type { CheckResult } from '@bht/insights';
import { describe, expect, test } from 'vitest';
import { expectedRangeLine, observedText, statusText } from './readings.ts';

const window = { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z' };
const ok = (check: CheckResult['check']): CheckResult => ({
  check,
  window,
  citations: [],
  status: 'ok',
  observed: { value: 6, unit: 'count', expected: { min: 6 } },
});
const ml = (v: number) => `${v} mL`;

describe('readings copy', () => {
  test('the expected-range line names only ok checks, never the none-logged ones', () => {
    const missing: CheckResult = {
      check: 'stools',
      window,
      citations: [],
      status: 'not_enough_data',
      reason: 'not_fully_logged',
    };
    expect(expectedRangeLine([ok('pale_stool'), ok('blood_in_stool'), missing])).toBeNull();
    expect(expectedRangeLine([ok('wet_diapers')])).toBe('In the expected range: wet diapers');
    expect(expectedRangeLine([ok('wet_diapers'), ok('pale_stool'), ok('weight_trend')])).toBe(
      'In the expected range: wet diapers and weight trend',
    );
    expect(expectedRangeLine([ok('wet_diapers'), ok('feeds'), ok('weight_trend')])).toBe(
      'In the expected range: wet diapers, feeds and weight trend',
    );
    expect(statusText(missing, ml)).toBe('Not enough data');
  });

  test('a red-flag check that found nothing reads "None logged", not a value', () => {
    expect(statusText(ok('black_stool'), ml)).toBe('None logged');
    expect(statusText(ok('wet_diapers'), ml)).toBe('6 · expected at least 6');
  });

  test('observed values carry their unit, and volumes use the mL/oz preference', () => {
    expect(observedText({ value: 7.25, unit: 'pct', expected: { max: 10 } }, ml)).toBe(
      '7.3% · expected at most 10%',
    );
    expect(observedText({ value: 950, unit: 'mL', expected: { max: 900 } }, ml)).toBe(
      '950 mL · expected at most 900 mL',
    );
    expect(observedText({ value: 3, unit: 'h', expected: {} }, ml)).toBe('3 h');
    expect(observedText({ value: 20, unit: 'g/day', expected: { min: 15, max: 30 } }, ml)).toBe(
      '20 g/day · expected 15–30 g/day',
    );
  });
});
