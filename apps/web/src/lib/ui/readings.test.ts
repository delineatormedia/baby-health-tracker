import { evaluate, type CheckResult, type Observed } from '@bht/insights';
import { newId, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  expectedRangeLine,
  fullyLogged,
  marksIn,
  observedText,
  REASON_TEXT,
  statusText,
} from './readings.ts';

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
      reason: 'no_recent_weight',
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

  test('a flag never says its own value is expected', () => {
    const flag = (check: CheckResult['check'], observed: Observed): CheckResult => ({
      check,
      window,
      citations: [],
      status: 'flag',
      urgency: 'consider',
      title: 't',
      why: 'w',
      observed,
      evidence: [],
    });
    // Positive-evidence flags fire on one sighting (gte 1): "1 logged", not "expected at most 1".
    expect(
      statusText(flag('pale_stool', { value: 1, unit: 'count', expected: { max: 1 } }), ml),
    ).toBe('1 logged');
    expect(
      statusText(flag('blood_in_stool', { value: 2, unit: 'count', expected: { max: 1 } }), ml),
    ).toBe('2 logged');
  });

  test('#26: the wording follows the operator, on or off the bound', () => {
    const flag = (observed: Observed): CheckResult => ({
      check: 'weight_loss',
      window,
      citations: [],
      status: 'flag',
      urgency: 'consider',
      title: 't',
      why: 'w',
      observed,
      evidence: [],
    });
    const pct = (value: number, expected: Observed['expected']) =>
      statusText(flag({ value, unit: 'pct', expected }), ml);
    // gte 8 (ABM): 8 itself flags. Off the bound too, never "at most 8".
    expect(pct(9, { max: 8, maxStrict: true })).toBe('9% · expected below 8%');
    expect(pct(8, { max: 8, maxStrict: true })).toBe('8% · expected below 8%');
    // gt 10 (NICE): 10 is fine.
    expect(pct(11, { max: 10, maxStrict: false })).toBe('11% · expected at most 10%');
    // lte 2: 2 itself flags. lt 6: 6 is fine.
    const count = (value: number, expected: Observed['expected']) =>
      statusText({ ...flag({ value, unit: 'count', expected }), check: 'wet_diapers' }, ml);
    expect(count(1, { min: 2, minStrict: true })).toBe('1 · expected above 2');
    expect(count(4, { min: 6, minStrict: false })).toBe('4 · expected at least 6');
    // Both ends: an inclusive pair stays a range; a strict end spells both out.
    expect(observedText({ value: 3, unit: 'count', expected: { min: 2, max: 8 } }, ml)).toBe(
      '3 · expected 2–8',
    );
    expect(
      observedText({ value: 9, unit: 'count', expected: { min: 2, max: 8, maxStrict: true } }, ml),
    ).toBe('9 · expected at least 2 and below 8');
  });
});

describe('"We missed some" (#24)', () => {
  const D = 86_400_000;
  const BIRTH = Date.parse('2026-10-20T03:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const baby = newId();
  const ev = (type: BabyEvent['type'], at: number, data: unknown, extra = {}): BabyEvent =>
    ({
      id: newId(),
      babyId: baby,
      authorId: baby,
      occurredAt: iso(at),
      recordedAt: iso(at),
      version: 1,
      deleted: false,
      notes: null,
      type,
      data,
      ...extra,
    }) as BabyEvent;
  // Day of life 5 is [BIRTH + 4 D, BIRTH + 5 D); it is the latest completed day an hour later.
  const NOW = BIRTH + 5 * D + 3_600_000;
  const day = { start: iso(BIRTH + 4 * D), end: iso(BIRTH + 5 * D) };
  const twoWet = [1, 2].map((h) => ev('diaper', BIRTH + 4 * D + h * 3_600_000, { kind: 'wet' }));
  const mark = ev('missed_logs', BIRTH + 4 * D, day);

  /** Readings as the page runs it: everything counts as fully logged except marks. */
  const wet = (events: BabyEvent[]) =>
    evaluate({
      baby: { birthAt: iso(BIRTH), sex: 'female' },
      events,
      now: iso(NOW),
      fullyLogged: fullyLogged(iso(BIRTH), NOW, events),
      syncedThrough: iso(NOW),
    }).find((r) => r.check === 'wet_diapers')!;

  test('an unmarked day with low counts flags', () => {
    const r = wet(twoWet);
    expect(r.status).toBe('flag');
    expect(r.window).toEqual(day);
  });

  test('the same day marked "missed some" is not assessed, and says why', () => {
    const r = wet([...twoWet, mark]);
    expect(r).toMatchObject({ status: 'not_enough_data', reason: 'not_fully_logged' });
    expect(statusText(r, ml)).toBe('Not assessed');
    expect(r.status === 'not_enough_data' && REASON_TEXT[r.reason]).toBe(
      'You marked missing logs for this day',
    );
    expect(marksIn([...twoWet, mark], r.window).map((m) => m.id)).toEqual([mark.id]);
  });

  test('unmarking (the mark deleted) restores the flag', () => {
    const undone = { ...mark, version: 2, deleted: true } as BabyEvent;
    expect(wet([...twoWet, undone]).status).toBe('flag');
    expect(marksIn([undone], day)).toEqual([]);
  });

  test('a mark on another day leaves this one assessed', () => {
    const other = ev('missed_logs', BIRTH + 2 * D, {
      start: iso(BIRTH + 2 * D),
      end: iso(BIRTH + 3 * D),
    });
    expect(wet([...twoWet, other]).status).toBe('flag');
  });

  test('fully logged is birth to now with the marked periods cut out', () => {
    expect(fullyLogged(iso(BIRTH), NOW, [])).toEqual([{ start: iso(BIRTH), end: iso(NOW) }]);
    expect(fullyLogged(iso(BIRTH), NOW, [mark])).toEqual([
      { start: iso(BIRTH), end: day.start },
      { start: day.end, end: iso(NOW) },
    ]);
    // Overlapping marks and one running past now.
    const late = ev('missed_logs', BIRTH + 4 * D + 1000, {
      start: iso(BIRTH + 4 * D + 1000),
      end: iso(NOW + D),
    });
    expect(fullyLogged(iso(BIRTH), NOW, [late, mark])).toEqual([
      { start: iso(BIRTH), end: day.start },
    ]);
  });
});
