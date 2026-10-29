import { describe, expect, test } from 'vitest';
import {
  formatVolume,
  formatWeight,
  fromMl,
  gramsToLbOz,
  lbOzToGrams,
  ML_PER_FL_OZ,
  toMl,
} from './units.ts';

describe('volume', () => {
  test.each([0.5, 1, 2, 2.5, 3, 4, 4.5, 6, 8])('%s oz entered shows %s oz', (oz) => {
    const stored = toMl(oz, 'oz');
    expect(formatVolume(stored, 'oz')).toBe(`${oz} oz`);
    expect(fromMl(stored, 'oz')).toBeCloseTo(oz, 10);
  });

  test.each([5, 30, 60, 90, 118, 120, 150])('%s mL entered shows %s mL', (ml) => {
    expect(formatVolume(toMl(ml, 'ml'), 'ml')).toBe(`${ml} mL`);
  });

  test('4 oz does not display as 3.99', () => {
    expect(formatVolume(toMl(4, 'oz'), 'oz')).toBe('4 oz');
    expect(formatVolume(toMl(4, 'oz'), 'ml')).toBe('118 mL');
  });

  test('uses the exact US fluid ounce', () => {
    expect(ML_PER_FL_OZ).toBe(29.5735295625);
  });

  test('both shows mL then oz', () => {
    expect(formatVolume(120, 'both')).toBe('120 mL (4.1 oz)');
    expect(formatVolume(toMl(2, 'oz'), 'both')).toBe('59 mL (2 oz)');
  });

  test('zero formats without a sign', () => {
    expect(formatVolume(0, 'oz')).toBe('0 oz');
  });
});

describe('weight', () => {
  test('lb + oz round-trips', () => {
    expect(gramsToLbOz(lbOzToGrams(7, 8))).toEqual({ lb: 7, oz: 8 });
    expect(formatWeight(lbOzToGrams(7, 8), 'lb_oz')).toBe('7 lb 8 oz');
    expect(formatWeight(lbOzToGrams(6, 15.5), 'lb_oz')).toBe('6 lb 15.5 oz');
  });

  test('ounces that round up to 16 carry into a pound', () => {
    expect(gramsToLbOz(lbOzToGrams(7, 15.99))).toEqual({ lb: 8, oz: 0 });
  });

  test('kg shows two decimals', () => {
    expect(formatWeight(3450, 'kg')).toBe('3.45 kg');
    expect(formatWeight(3000, 'kg')).toBe('3.00 kg');
  });

  test('a 3.5 kg baby is 7 lb 11.5 oz', () => {
    expect(formatWeight(3500, 'lb_oz')).toBe('7 lb 11.5 oz');
  });
});
