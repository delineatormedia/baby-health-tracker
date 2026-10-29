/** US customary fluid ounce, exact by definition. */
export const ML_PER_FL_OZ = 29.5735295625;
/** Avoirdupois pound and ounce, exact by definition. */
export const GRAMS_PER_LB = 453.59237;
export const GRAMS_PER_OZ = GRAMS_PER_LB / 16;

export type VolumeUnit = 'ml' | 'oz';
export type VolumeDisplay = 'ml' | 'oz' | 'both';
export type WeightDisplay = 'kg' | 'lb_oz';

/**
 * Converts an entered volume to mL. Stored values are NOT rounded, so a volume
 * entered in oz converts back to exactly what was typed.
 */
export function toMl(value: number, unit: VolumeUnit): number {
  return unit === 'ml' ? value : value * ML_PER_FL_OZ;
}

export function fromMl(ml: number, unit: VolumeUnit): number {
  return unit === 'ml' ? ml : ml / ML_PER_FL_OZ;
}

/** Rounds to `decimals` places and drops trailing zeros: 4.0 → "4", 2.50 → "2.5". */
function trim(value: number, decimals: number): string {
  const f = 10 ** decimals;
  const rounded = Math.round(value * f) / f;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Whole mL; oz to one decimal (feeds are measured in 0.5 oz steps at best). */
export function formatVolume(ml: number, display: VolumeDisplay): string {
  const mlText = `${trim(ml, 0)} mL`;
  const ozText = `${trim(fromMl(ml, 'oz'), 1)} oz`;
  if (display === 'ml') return mlText;
  if (display === 'oz') return ozText;
  return `${mlText} (${ozText})`;
}

export function lbOzToGrams(lb: number, oz: number): number {
  return lb * GRAMS_PER_LB + oz * GRAMS_PER_OZ;
}

/** Whole pounds plus ounces rounded to one decimal, carrying 16 oz into a pound. */
export function gramsToLbOz(grams: number): { lb: number; oz: number } {
  const totalOz = Math.round((grams / GRAMS_PER_OZ) * 10) / 10;
  const lb = Math.floor(totalOz / 16);
  const oz = Math.round((totalOz - lb * 16) * 10) / 10;
  return { lb, oz };
}

/** kg to two decimals (10 g resolution, typical of baby scales); lb + oz to 0.1 oz. */
export function formatWeight(grams: number, display: WeightDisplay): string {
  if (display === 'kg') return `${(grams / 1000).toFixed(2)} kg`;
  const { lb, oz } = gramsToLbOz(grams);
  return `${lb} lb ${trim(oz, 1)} oz`;
}
