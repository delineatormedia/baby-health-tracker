import { lbOzToGrams, type BabyEvent } from '@bht/schema';

// Weight entry (#35). Mirrors the schema's typo bounds: insights judge what is normal.

export type Weight = Extract<BabyEvent, { type: 'weight' }>;

export const MIN_GRAMS = 300;
export const MAX_GRAMS = 30_000;
const MAX_DIGITS = 5;

/** Weights, newest first (events arrive newest first). */
export function weights(events: readonly BabyEvent[]): Weight[] {
  return events.filter((e): e is Weight => e.type === 'weight' && !e.deleted);
}

/** One keypad tap on the gram readout. No leading zero, at most five digits. */
export function typeDigit(digits: string, d: string): string {
  if (!/^\d$/.test(d) || digits.length >= MAX_DIGITS) return digits;
  if (digits === '' && d === '0') return digits;
  return digits + d;
}

export const backspace = (digits: string) => digits.slice(0, -1);

const inBounds = (g: number) => Number.isFinite(g) && g >= MIN_GRAMS && g <= MAX_GRAMS;

/** Grams from the keypad, or null when empty or outside the schema bounds. */
export function gramsFromDigits(digits: string): number | null {
  if (!/^\d+$/.test(digits)) return null;
  const g = Number(digits);
  return inBounds(g) ? g : null;
}

/**
 * Grams from pounds and ounces as typed ("7", "12.5"), unrounded so it converts back to what
 * was typed. Null unless lb is whole, oz is under 16, and the total is inside the bounds.
 * An empty oz field is 0 oz.
 */
export function gramsFromLbOz(lb: string, oz: string): number | null {
  const l = lb.trim();
  const o = oz.trim().replace(',', '.');
  if (!/^\d{1,2}$/.test(l)) return null;
  if (o !== '' && !/^\d{1,2}(\.\d{0,2})?$/.test(o)) return null;
  const ounces = o === '' ? 0 : Number(o);
  if (ounces >= 16) return null;
  const g = lbOzToGrams(Number(l), ounces);
  return inBounds(g) ? g : null;
}
