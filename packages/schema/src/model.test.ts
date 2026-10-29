import { decodeTime } from 'ulid';
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { Baby, Id, newId, Timestamp } from './model.ts';

describe('Id', () => {
  test('newId produces valid, sortable ULIDs', () => {
    const ids = Array.from({ length: 1000 }, newId);
    expect(ids.every((id) => v.is(Id, id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  test('accepts the largest valid ULID', () => {
    expect(v.is(Id, '7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(true);
    expect(decodeTime('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(2 ** 48 - 1);
  });

  test('rejects the first overflowing ULID', () => {
    expect(v.is(Id, '80000000000000000000000000')).toBe(false);
    expect(() => decodeTime('80000000000000000000000000')).toThrow();
  });

  test.each(['', 'abc', '01ARZ3NDEKTSV4RRFFQ69G5FA', '01ARZ3NDEKTSV4RRFFQ69G5FAI'])(
    'rejects %j',
    (s) => {
      expect(v.is(Id, s)).toBe(false);
    },
  );
});

describe('Timestamp', () => {
  test('accepts toISOString output', () => {
    expect(v.is(Timestamp, new Date().toISOString())).toBe(true);
  });

  test.each([
    '2026-10-29T03:00:00Z',
    '2026-10-29T03:00:00.000+00:00',
    '2026-10-29 03:00:00.000Z',
    '2026-02-30T03:00:00.000Z',
    '2026-10-29T25:00:00.000Z',
  ])('rejects %j', (s) => {
    expect(v.is(Timestamp, s)).toBe(false);
  });
});

describe('Baby', () => {
  const baby = {
    id: newId(),
    householdId: newId(),
    name: 'Ada',
    birthAt: '2026-10-20T14:32:00.000Z',
    sex: 'female',
  };

  test('accepts a baby', () => {
    expect(v.is(Baby, baby)).toBe(true);
  });

  test('rejects an empty name, an unknown sex and extra keys', () => {
    expect(v.is(Baby, { ...baby, name: '  ' })).toBe(false);
    expect(v.is(Baby, { ...baby, sex: 'f' })).toBe(false);
    expect(v.is(Baby, { ...baby, weight: 3400 })).toBe(false);
  });
});
