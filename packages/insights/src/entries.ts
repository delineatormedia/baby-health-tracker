import data from '../data/thresholds.json' with { type: 'json' };

/** One cited threshold from data/thresholds.json. docs/CLINICAL_REFERENCE.md documents the contract. */
export interface ThresholdEntry {
  id: string;
  metric: string;
  value: number | { min: number; max: number };
  unit: string;
  age_range: {
    from_days?: number;
    to_days?: number;
    from_hours?: number;
    to_hours?: number;
    basis: 'source' | 'app_choice';
  };
  interval?: { from_days: number; to_days: number };
  direction:
    'below_min_flag' | 'above_max_flag' | 'red_flag_any' | 'expected_range' | 'informational';
  op?: 'lt' | 'lte' | 'gt' | 'gte';
  status?: 'deferred';
  /** Signs the source pairs with this threshold. v1 logs none of them, so the entry never flags. */
  requires_signs?: string[];
  suppressed_by?: { id: string; when: string }[];
  sex?: 'male' | 'female';
  confidence: 'high' | 'moderate' | 'low';
  source: { title: string; organization: string; url: string };
  notes: string;
}

export const ENTRIES = data as unknown as readonly ThresholdEntry[];

const byId = new Map(ENTRIES.map((e) => [e.id, e]));

export function entry(id: string): ThresholdEntry {
  const e = byId.get(id);
  if (!e) throw new Error(`Unknown threshold entry ${id}`);
  return e;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Is the entry's age window open at this age? Deferred entries are never active. */
export function activeAt(e: ThresholdEntry, ageMs: number): boolean {
  if (e.status === 'deferred' || ageMs < 0) return false;
  const a = e.age_range;
  if (a.from_hours !== undefined && a.to_hours !== undefined) {
    return ageMs >= a.from_hours * HOUR_MS && ageMs < a.to_hours * HOUR_MS;
  }
  // Completed days since birth, from inclusive and to exclusive (#11 conventions).
  const days = Math.floor(ageMs / DAY_MS);
  return days >= (a.from_days ?? 0) && days < (a.to_days ?? 0);
}

const FLAGGING = new Set(['below_min_flag', 'above_max_flag', 'red_flag_any']);

/** Cited under "why?" when active: flagging entries, including ones that may never win. */
export function isCitable(e: ThresholdEntry): boolean {
  return FLAGGING.has(e.direction) && e.status !== 'deferred';
}

/**
 * Can this entry raise a flag? Low-confidence entries and entries that need signs the app
 * does not log are cited but never flag (#11: "Low-confidence entries never win").
 */
export function canFlag(e: ThresholdEntry): boolean {
  return isCitable(e) && e.confidence !== 'low' && !e.requires_signs?.length;
}

/** Does the observed value trip this entry's comparison? Ignores age and confidence. */
export function trips(e: ThresholdEntry, observed: number): boolean {
  const v = e.value;
  if (typeof v !== 'number') throw new Error(`${e.id}: range values do not flag`);
  switch (e.op) {
    case 'lt':
      return observed < v;
    case 'lte':
      return observed <= v;
    case 'gt':
      return observed > v;
    case 'gte':
      return observed >= v;
    default:
      throw new Error(`${e.id}: flagging entry without op`);
  }
}
