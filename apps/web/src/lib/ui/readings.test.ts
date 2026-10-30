import { evaluate, type CheckResult, type Observed } from '@bht/insights';
import { newId, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  COUNT_CHECKS,
  expectedRangeLine,
  fullyLogged,
  loggingStart,
  marksIn,
  observedText,
  REASON_TEXT,
  lastSyncedTime,
  reasonText,
  statusText,
  waitingText,
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

  test('a day with no feed logged never claims other feeds were logged', () => {
    expect(REASON_TEXT.no_feeds_logged).toBe('No feeds logged');
    expect(REASON_TEXT.feeding_not_exclusive).toContain('other feeds were logged');
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

  /** Readings as the page runs it, logging from birth: fully logged except marks. */
  const wet = (events: BabyEvent[]) =>
    evaluate({
      baby: { birthAt: iso(BIRTH), sex: 'female' },
      events,
      now: iso(NOW),
      fullyLogged: fullyLogged(iso(BIRTH), NOW, events, BIRTH),
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
    expect(fullyLogged(iso(BIRTH), NOW, [], BIRTH)).toEqual([{ start: iso(BIRTH), end: iso(NOW) }]);
    expect(fullyLogged(iso(BIRTH), NOW, [mark], BIRTH)).toEqual([
      { start: iso(BIRTH), end: day.start },
      { start: day.end, end: iso(NOW) },
    ]);
    // Overlapping marks and one running past now.
    const late = ev('missed_logs', BIRTH + 4 * D + 1000, {
      start: iso(BIRTH + 4 * D + 1000),
      end: iso(NOW + D),
    });
    expect(fullyLogged(iso(BIRTH), NOW, [late, mark], BIRTH)).toEqual([
      { start: iso(BIRTH), end: day.start },
    ]);
  });

  describe('before logging began', () => {
    const H = 3_600_000;
    const SETUP = BIRTH + 50 * H;
    // From install at 50 h: a wet diaper every 3 h, a dirty one every 6 h, a feed every 2 h.
    const every = (h: number, make: (t: number) => BabyEvent) =>
      Array.from({ length: Math.floor((5 * D - 50 * H) / (h * H)) }, (_, i) =>
        make(SETUP + i * h * H),
      );
    const log = [
      ...every(3, (t) => ev('diaper', t, { kind: 'wet' })),
      ...every(6, (t) =>
        ev('diaper', t, {
          kind: 'dirty',
          stool: { color: null, consistency: null, size: null, flags: [] },
        }),
      ),
      ...every(2, (t) => ev('breastfeed', t, { side: 'left', durationSeconds: 900 })),
    ];
    const readings = (now: number) => {
      const events = log.filter((e) => Date.parse(e.occurredAt) <= now);
      const start = loggingStart(SETUP, events);
      const results = evaluate({
        baby: { birthAt: iso(BIRTH), sex: 'female' },
        events,
        now: iso(now),
        fullyLogged: fullyLogged(iso(BIRTH), now, events, start),
        syncedThrough: iso(now),
      });
      return { start, results };
    };

    test('install at 50 h: the day-1 and day-2 windows are not flagged', () => {
      // Day 2 ([24, 48 h)) is the latest completed day Readings shows from install until 72 h.
      for (const now of [SETUP, SETUP + H, BIRTH + 3 * D - 1]) {
        const { start, results } = readings(now);
        expect(start).toBe(SETUP);
        for (const check of COUNT_CHECKS) {
          const r = results.find((x) => x.check === check)!;
          expect(r, check).toMatchObject({ status: 'not_enough_data', reason: 'not_fully_logged' });
          expect(r.window).toEqual({ start: iso(BIRTH + D), end: iso(BIRTH + 2 * D) });
          expect(reasonText(r, start)).toBe('Before you started logging');
        }
        expect(results.filter((r) => r.status === 'flag')).toEqual([]);
      }
      // Day 1 was over before install, so no period of it counts as logged; nothing in it can
      // be assessed, whichever check asks.
      const covered = fullyLogged(iso(BIRTH), BIRTH + 5 * D, log, loggingStart(SETUP, log));
      expect(covered).toEqual([{ start: iso(SETUP), end: iso(BIRTH + 5 * D) }]);
    });

    test('day 3 began before install too; day 4 is fully logged and assessed', () => {
      const day3 = readings(BIRTH + 3 * D + H).results.find((r) => r.check === 'wet_diapers')!;
      expect(day3.window.start).toBe(iso(BIRTH + 2 * D));
      expect(reasonText(day3, SETUP)).toBe('Before you started logging');
      const { results } = readings(BIRTH + 4 * D + H);
      for (const check of COUNT_CHECKS) {
        expect(results.find((r) => r.check === check)!.status, check).toBe('ok');
      }
      // A day after install with too few logs still flags: fully logged by default.
      const sparse = log.filter(
        (e) => e.type !== 'diaper' || Date.parse(e.occurredAt) < BIRTH + 3 * D,
      );
      const events = sparse.filter((e) => Date.parse(e.occurredAt) <= BIRTH + 4 * D + H);
      const now = BIRTH + 4 * D + H;
      const r = evaluate({
        baby: { birthAt: iso(BIRTH), sex: 'female' },
        events,
        now: iso(now),
        fullyLogged: fullyLogged(iso(BIRTH), now, events, loggingStart(SETUP, events)),
        syncedThrough: iso(now),
      }).find((x) => x.check === 'wet_diapers')!;
      expect(r.status).toBe('flag');
    });

    test("a marked gap after install still reads as the parents' mark", () => {
      const m = ev('missed_logs', BIRTH + 3 * D, {
        start: iso(BIRTH + 3 * D),
        end: iso(BIRTH + 4 * D),
      });
      const now = BIRTH + 4 * D + H;
      const events = [...log.filter((e) => Date.parse(e.occurredAt) <= now), m];
      const start = loggingStart(SETUP, events);
      const r = evaluate({
        baby: { birthAt: iso(BIRTH), sex: 'female' },
        events,
        now: iso(now),
        fullyLogged: fullyLogged(iso(BIRTH), now, events, start),
        syncedThrough: iso(now),
      }).find((x) => x.check === 'wet_diapers')!;
      expect(reasonText(r, start)).toBe('You marked missing logs for this day');
    });

    test('logging starts at the earlier of setup and the first logged event', () => {
      const back = ev('diaper', BIRTH + 10 * H, { kind: 'wet' });
      expect(loggingStart(SETUP, [back, ...log])).toBe(BIRTH + 10 * H);
      expect(loggingStart(null, log)).toBe(SETUP);
      expect(loggingStart(SETUP, [])).toBe(SETUP);
      expect(loggingStart(null, [])).toBeNull();
      // A deleted event or a mark does not move it.
      expect(loggingStart(SETUP, [{ ...back, deleted: true } as BabyEvent, m0()])).toBe(SETUP);
      expect(fullyLogged(iso(BIRTH), SETUP + H, [], null)).toEqual([]);
      expect(fullyLogged(iso(BIRTH), SETUP + H, [], SETUP)).toEqual([
        { start: iso(SETUP), end: iso(SETUP + H) },
      ]);
    });
    const m0 = () => ev('missed_logs', BIRTH, { start: iso(BIRTH), end: iso(BIRTH + D) });
  });
});

describe('waiting on other phones (#5 step 3b)', () => {
  const sam = {
    deviceId: '01JBC0000000000000000000SA',
    memberName: 'Sam',
    watermark: Date.parse('2026-10-28T01:14:00.000Z'),
    lastSeenAt: 0,
    removedAt: null,
  };
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);

  test('a check waiting on another phone reads "Not assessed"', () => {
    const r: CheckResult = {
      check: 'wet_diapers',
      window,
      citations: [],
      status: 'not_enough_data',
      reason: 'not_synced',
    } as CheckResult;
    expect(statusText(r, String)).toBe('Not assessed');
  });

  test('names the phone and when it last synced', () => {
    expect(waitingText([sam], time)).toBe('Waiting for Sam’s phone (last synced 01:14)');
  });

  test('a phone with no watermark has not synced yet; several are listed', () => {
    const ana = { ...sam, memberName: 'Ana', watermark: null };
    expect(waitingText([sam, ana], time)).toBe(
      'Waiting for Sam’s phone (last synced 01:14) and Ana’s phone (not synced yet)',
    );
  });

  test('before the first full pull there is no list to name', () => {
    expect(waitingText([])).toBe('Waiting for the first sync with your household');
  });

  test('the default time reads like "Tue 9:14 PM"', () => {
    expect(lastSyncedTime(sam.watermark!)).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2}\s[AP]M$/);
  });
});
