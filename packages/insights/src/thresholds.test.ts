import { describe, expect, test } from 'vitest';
import data from '../data/thresholds.json' with { type: 'json' };

// Data-contract checks for data/thresholds.json. The evaluator below is a
// reference reading of the documented contract, not the insights engine.

type Value = number | { min: number; max: number };
type Op = 'lt' | 'lte' | 'gt' | 'gte';

interface Entry {
  id: string;
  metric: string;
  value: Value;
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
  op?: Op;
  status?: 'deferred';
  requires_signs?: string[];
  suppressed_by?: { id: string; when: string }[];
  source_value?: Value;
  source_unit?: string;
  conversion?: { from: string; to: string; divide_by: number; approximate: boolean };
  sex?: 'male' | 'female';
  source: { title: string; url: string };
  notes: string;
}

const entries = data as unknown as Entry[];
const byId = new Map(entries.map((e) => [e.id, e]));

function entry(id: string): Entry {
  const e = byId.get(id);
  if (!e) throw new Error(`missing entry ${id}`);
  return e;
}

const FLAGGING = new Set(['below_min_flag', 'above_max_flag', 'red_flag_any']);

/** Is the entry active at this age? Age in hours since birth. */
function active(e: Entry, ageHours: number): boolean {
  if (e.status === 'deferred' || e.requires_signs || !FLAGGING.has(e.direction)) return false;
  const a = e.age_range;
  if (a.from_hours !== undefined && a.to_hours !== undefined) {
    return ageHours >= a.from_hours && ageHours < a.to_hours;
  }
  const days = Math.floor(ageHours / 24);
  return days >= (a.from_days ?? 0) && days < (a.to_days ?? 0);
}

/** Does the entry flag this observed value at this age? */
function flags(e: Entry, ageHours: number, observed: number): boolean {
  if (!active(e, ageHours)) return false;
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

const days = (n: number) => n * 24;

describe('contract', () => {
  test('ids are unique', () => {
    expect(byId.size).toBe(entries.length);
  });

  test('every flagging entry has an explicit operator, others have none', () => {
    for (const e of entries) {
      if (FLAGGING.has(e.direction)) expect(e.op, e.id).toMatch(/^(lt|lte|gt|gte)$/);
      else expect(e.op, e.id).toBeUndefined();
    }
  });

  test('age windows use days or hours, never both, and say where they come from', () => {
    for (const e of entries) {
      const a = e.age_range;
      const hasDays = a.from_days !== undefined && a.to_days !== undefined;
      const hasHours = a.from_hours !== undefined && a.to_hours !== undefined;
      expect(hasDays !== hasHours, e.id).toBe(true);
      expect(['source', 'app_choice'], e.id).toContain(a.basis);
      const [from, to] = hasDays ? [a.from_days!, a.to_days!] : [a.from_hours!, a.to_hours!];
      expect(from, e.id).toBeLessThan(to);
    }
  });

  test('suppressing entries exist', () => {
    for (const e of entries)
      for (const s of e.suppressed_by ?? []) expect(byId.has(s.id), e.id).toBe(true);
  });

  test('values converted from grams keep the source value and say so', () => {
    for (const e of entries) {
      if (e.source_unit === undefined) continue;
      expect(e.conversion, e.id).toEqual({
        from: 'g',
        to: 'mL',
        divide_by: 1.03,
        approximate: true,
      });
      expect(e.unit, e.id).toBe('mL');
      const conv = (x: number) => x / 1.03;
      if (typeof e.value === 'number') {
        expect(e.value, e.id).toBeCloseTo(conv(e.source_value as number), 0);
      } else {
        const sv = e.source_value as { min: number; max: number };
        expect(e.value.min, e.id).toBeCloseTo(conv(sv.min), 0);
        expect(e.value.max, e.id).toBeCloseTo(conv(sv.max), 0);
      }
    }
  });

  test('WHO increments evaluate after the whole interval has been observed', () => {
    const who = entries.filter((e) => e.id.startsWith('weight_gain_who_p5_'));
    expect(who).toHaveLength(12);
    for (const e of who) {
      expect(e.interval, e.id).toBeDefined();
      expect(e.age_range.from_days, e.id).toBe(e.interval!.to_days);
    }
  });
});

// The review's boundary cases (#11 audit at 50874d1), with the corrected results.
describe('boundaries', () => {
  test('downward centile crossings flag at the cited count, not at zero', () => {
    const aap = entry('weight_percentile_drop_major_lines_aap');
    expect(flags(aap, days(30), 0)).toBe(false);
    expect(flags(aap, days(30), 1)).toBe(false);
    expect(flags(aap, days(30), 2)).toBe(true);
    for (const [id, n] of [
      ['weight_centile_drop_nice_bw_lt9', 1],
      ['weight_centile_drop_nice_bw_9_91', 2],
      ['weight_centile_drop_nice_bw_gt91', 3],
    ] as const) {
      expect(flags(entry(id), days(30), 0), id).toBe(false);
      expect(flags(entry(id), days(30), n - 1), id).toBe(false);
      expect(flags(entry(id), days(30), n), id).toBe(true);
    }
  });

  test('severe dehydration count includes exactly two wet diapers', () => {
    const e = entry('wet_diapers_severe_dehydration');
    expect(flags(e, days(7), 2)).toBe(true);
    expect(flags(e, days(7), 3)).toBe(false);
  });

  test('ABM meconium rule is active at exactly 120 hours, not before', () => {
    const e = entry('meconium_persisting_dol5');
    expect(flags(e, 119, 1)).toBe(false);
    expect(flags(e, 120, 1)).toBe(true);
  });

  test('ABM 8% rule includes exactly 8% and starts at 120 hours', () => {
    const e = entry('weight_loss_abm_pct_8_from_dol5');
    expect(flags(e, days(5), 8)).toBe(true);
    expect(flags(e, days(5), 7.9)).toBe(false);
    expect(flags(e, 119, 9)).toBe(false);
  });

  test('a single pale stool does not trigger the two-occurrence record, but the any-occurrence rule does', () => {
    expect(flags(entry('stool_pale_white_repeated'), days(10), 1)).toBe(false);
    expect(flags(entry('stool_pale_white_repeated'), days(10), 2)).toBe(true);
    expect(flags(entry('stool_pale_white_any'), days(10), 1)).toBe(true);
  });

  test('not regained birth weight at exactly 21 completed days flags under NICE', () => {
    const nice = entry('regain_birth_weight_nice_days');
    expect(nice.metric).toBe('age_days_without_regaining_birth_weight');
    expect(flags(nice, days(21), 21)).toBe(true);
    expect(flags(nice, days(20), 20)).toBe(false);
    const aap = entry('regain_birth_weight_aap_days');
    expect(flags(aap, days(14), 14)).toBe(true);
    expect(flags(aap, days(13), 13)).toBe(false);
  });

  test('birth-to-four-week WHO increment is evaluated at day 28', () => {
    const e = entry('weight_gain_who_p5_0_4w_male');
    expect(flags(e, days(27), 400)).toBe(false);
    expect(flags(e, days(28), 400)).toBe(true);
    expect(flags(e, days(28), 460)).toBe(false);
  });

  test('NEWT 75th-percentile rule stays deferred', () => {
    const e = entry('weight_loss_newt_75th_percentile');
    expect(e.status).toBe('deferred');
    expect(active(e, 48)).toBe(false);
  });

  test('AAP low-stool flag ends at four weeks, as KidsDoc says', () => {
    const e = entry('stools_min_aap_from_dol5');
    expect(flags(e, days(27), 1)).toBe(true);
    expect(flags(e, days(35), 1)).toBe(false);
    expect(e.suppressed_by?.map((s) => s.id)).toContain('stool_interval_breastfed_normal');
  });

  test('the composite dehydration gap needs signs v1 does not log, so it never flags alone', () => {
    const composite = entry('no_urine_hours_dehydration');
    expect(composite.requires_signs).toEqual([
      'dark_urine',
      'no_stool_24h',
      'very_dry_mouth',
      'no_tears',
    ]);
    expect(flags(composite, days(3), 9)).toBe(false);
    expect(flags(entry('no_urine_hours_dol2_4'), days(3), 9)).toBe(true);
    expect(entries.filter((e) => e.requires_signs).map((e) => e.id)).toEqual([composite.id]);
  });

  test('legacy 7% loss and high weight-for-age never flag', () => {
    expect(active(entry('weight_loss_pct_7_legacy'), days(3))).toBe(false);
    expect(active(entry('weight_for_age_above_p97_7'), days(60))).toBe(false);
  });
});
