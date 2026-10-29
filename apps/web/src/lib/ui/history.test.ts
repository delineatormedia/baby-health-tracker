import { GRAMS_PER_LB, GRAMS_PER_OZ, newId, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { entryPath, glyph, grams, historyDays, rowText } from './history.ts';
import { backspace, gramsFromDigits, gramsFromLbOz, typeDigit, weights } from './weight.ts';

const baby = newId();
const author = newId();
const local = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

function ev<T extends BabyEvent['type']>(
  type: T,
  data: Extract<BabyEvent, { type: T }>['data'],
  occurredAt: string,
  extra: Partial<BabyEvent> = {},
): BabyEvent {
  return {
    id: newId(),
    babyId: baby,
    authorId: author,
    occurredAt,
    recordedAt: occurredAt,
    version: 1,
    deleted: false,
    notes: null,
    type,
    data,
    ...extra,
  } as BabyEvent;
}

const ml = (v: number) => `${v} mL`;

describe('historyDays', () => {
  const now = Date.parse(local(2026, 10, 28, 14));
  const wet = ev('diaper', { kind: 'wet' }, local(2026, 10, 28, 2, 59));
  const late = ev('diaper', { kind: 'wet' }, local(2026, 10, 28, 9));
  const yest = ev('weight', { grams: 3610, source: 'clinic' }, local(2026, 10, 27, 7, 15));
  const old = ev('bottle', { contents: 'formula', volumeMl: 60 }, local(2026, 10, 25, 23, 50));
  const mark = ev(
    'missed_logs',
    { start: local(2026, 10, 27, 0), end: local(2026, 10, 28, 0) },
    local(2026, 10, 27, 0),
  );
  const gone = ev('diaper', { kind: 'wet' }, local(2026, 10, 28, 3), { deleted: true });

  test('groups by local day, newest day and newest event first; skips marks and deletes', () => {
    const days = historyDays([old, wet, mark, late, yest, gone], 0, now);
    expect(days.map((d) => d.label.slice(0, 9))).toEqual([
      'Today',
      'Yesterday',
      days[2]!.label.slice(0, 9),
    ]);
    expect(days[0]!.events).toEqual([late, wet]);
    expect(days[1]!.events).toEqual([yest]);
    expect(days[2]!.events).toEqual([old]);
    expect(days[2]!.label).not.toMatch(/Today|Yesterday/);
    expect(days[0]!.start).toBe(Date.parse(local(2026, 10, 28, 0)));
    expect(days[0]!.end).toBe(Date.parse(local(2026, 10, 29, 0)));
  });

  test('a later day start moves a 3 AM event into the night before', () => {
    const days = historyDays([wet, late], 8 * 60, now);
    expect(days.map((d) => d.events)).toEqual([[late], [wet]]);
    expect(days[1]!.label).toBe('Yesterday');
    expect(days[1]!.start).toBe(Date.parse(local(2026, 10, 27, 8)));
    expect(days[1]!.end).toBe(Date.parse(local(2026, 10, 28, 8)));
  });

  test('an event exactly at the day start opens the new day', () => {
    const edge = ev('diaper', { kind: 'wet' }, local(2026, 10, 28, 0));
    expect(historyDays([edge], 0, now)[0]!.label).toBe('Today');
  });
});

describe('rows', () => {
  test('titles and captions follow the board', () => {
    const dirty = ev(
      'diaper',
      {
        kind: 'dirty',
        stool: { color: 'mustard', consistency: 'seedy', size: 'medium', flags: [] },
      },
      local(2026, 10, 28, 11, 20),
    );
    expect(rowText(dirty as never, ml)).toEqual({
      title: 'Dirty diaper',
      caption: 'Mustard · seedy · medium',
    });
    expect(glyph(dirty as never)).toBe('dirty');
    const bareDirty = ev('diaper', { kind: 'dirty', stool: null }, local(2026, 10, 28, 1));
    expect(rowText(bareDirty as never, ml).caption).toBeNull();
    const bottle = ev('bottle', { contents: 'breast_milk', volumeMl: 60 }, local(2026, 10, 28, 1));
    expect(rowText(bottle as never, ml)).toEqual({
      title: 'Bottle',
      caption: 'Breast milk · 60 mL',
    });
    const pump = ev('pump', { leftMl: 45, rightMl: 38, afterFeed: true }, local(2026, 10, 28, 1));
    expect(rowText(pump as never, ml).caption).toBe('45 mL L · 38 mL R · after feed');
    expect(glyph(pump as never)).toBe('pump');
    expect(entryPath(pump as never)).toBe(`/history/entry?id=${pump.id}`);
  });

  test('pump timers open the pump screen, not the time editor', () => {
    const running = ev(
      'pump',
      { side: 'left', durationSeconds: null, leftMl: null, rightMl: null, afterFeed: false },
      local(2026, 10, 28, 3),
    );
    expect(rowText(running as never, ml).caption).toBe('Left · running');
    expect(entryPath(running as never)).toBe('/pump');
    const stopped = ev(
      'pump',
      { side: 'both', durationSeconds: 900, leftMl: null, rightMl: null, afterFeed: false },
      local(2026, 10, 28, 4),
    );
    expect(rowText(stopped as never, ml).caption).toBe('15 min · add amount');
    expect(entryPath(stopped as never)).toBe('/pump');
    const w = ev('weight', { grams: 3610, source: 'clinic' }, local(2026, 10, 28, 1));
    expect(rowText(w as never, ml).caption).toBe('Clinic · 3 610 g · 7 lb 15.3 oz');
    expect(glyph(w as never)).toBeNull();
  });

  test('feeds: running, one side, both sides', () => {
    const running = ev(
      'breastfeed',
      {
        side: 'both',
        durationSeconds: null,
        segments: [
          { side: 'left', seconds: 300 },
          { side: 'right', seconds: null },
        ],
      },
      local(2026, 10, 28, 2, 51),
    );
    expect(rowText(running as never, ml).caption).toBe('Right · running');
    expect(entryPath(running as never)).toBe('/feed');
    const one = ev(
      'breastfeed',
      { side: 'left', durationSeconds: 840 },
      local(2026, 10, 28, 8, 40),
    );
    expect(rowText(one as never, ml).caption).toBe('Left · 14 min');
    expect(entryPath(one as never)).toBe(`/history/entry?id=${one.id}`);
    const two = ev(
      'breastfeed',
      {
        side: 'both',
        durationSeconds: 840,
        segments: [
          { side: 'left', seconds: 480 },
          { side: 'right', seconds: 360 },
        ],
      },
      local(2026, 10, 28, 8, 40),
    );
    expect(rowText(two as never, ml).caption).toBe('Left 8 min · Right 6 min');
  });

  test('grams groups thousands with a narrow space', () => {
    expect(grams(3640)).toBe('3 640 g');
    expect(grams(980)).toBe('980 g');
    expect(grams(12345.6)).toBe('12 346 g');
  });
});

describe('weight entry', () => {
  test('keypad: no leading zero, five digits at most, backspace', () => {
    let d = '';
    for (const k of ['0', '3', '6', '4', '0', '1', '2']) d = typeDigit(d, k);
    expect(d).toBe('36401');
    expect(backspace(d)).toBe('3640');
    expect(typeDigit('', 'x')).toBe('');
  });

  test('grams must sit inside the schema bounds', () => {
    expect(gramsFromDigits('')).toBeNull();
    expect(gramsFromDigits('299')).toBeNull();
    expect(gramsFromDigits('300')).toBe(300);
    expect(gramsFromDigits('3640')).toBe(3640);
    expect(gramsFromDigits('30000')).toBe(30000);
    expect(gramsFromDigits('30001')).toBeNull();
  });

  test('lb and oz convert exactly and reject 16 oz or more', () => {
    expect(gramsFromLbOz('8', '0.4')).toBe(8 * GRAMS_PER_LB + 0.4 * GRAMS_PER_OZ);
    expect(gramsFromLbOz('7', '')).toBe(7 * GRAMS_PER_LB);
    expect(gramsFromLbOz('7', '12,5')).toBe(7 * GRAMS_PER_LB + 12.5 * GRAMS_PER_OZ);
    expect(gramsFromLbOz('7', '16')).toBeNull();
    expect(gramsFromLbOz('', '5')).toBeNull();
    expect(gramsFromLbOz('7.5', '0')).toBeNull();
    expect(gramsFromLbOz('0', '5')).toBeNull();
    expect(gramsFromLbOz('70', '0')).toBeNull();
  });

  test('weights lists live weights only, newest first as given', () => {
    const a = ev('weight', { grams: 3610, source: 'clinic' }, local(2026, 10, 28, 1));
    const b = ev('weight', { grams: 3530, source: 'home' }, local(2026, 10, 27, 1));
    const c = ev('weight', { grams: 3500, source: 'home' }, local(2026, 10, 26, 1), {
      deleted: true,
    });
    const wet = ev('diaper', { kind: 'wet' }, local(2026, 10, 28, 1));
    expect(weights([a, wet, b, c])).toEqual([a, b]);
  });
});
