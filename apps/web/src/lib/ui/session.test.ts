import { newId, type Baby, type BabyEvent, type HouseholdView } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { babyPreparer, inviteCode, placeBaby } from './session.ts';

const householdId = newId();
const baby = (name: string, birthAt: string): Baby => ({
  id: newId(),
  householdId,
  name,
  birthAt,
  sex: 'female',
});
const view = (...babies: Baby[]): HouseholdView => ({ id: householdId, members: [], babies });

describe('placeBaby', () => {
  const ada = baby('Ada', '2026-09-01T08:00:00.000Z');
  const bo = baby('Bo', '2026-10-01T08:00:00.000Z');

  test("the household's own baby stays", () => {
    expect(placeBaby(ada, view(bo, ada))).toEqual({ kind: 'keep' });
  });

  test('a phone without a baby adopts the oldest', () => {
    expect(placeBaby(null, view(bo, ada))).toEqual({ kind: 'adopt', baby: ada });
  });

  test("a phone with its own baby chooses about the household's", () => {
    const mine = { ...baby('Mine', '2026-10-10T08:00:00.000Z'), householdId: newId() };
    expect(placeBaby(mine, view(ada))).toEqual({ kind: 'choose', baby: ada });
  });

  test('an empty household keeps the local baby, or leaves Setup to ask', () => {
    expect(placeBaby(ada, view())).toEqual({ kind: 'keep' });
    expect(placeBaby(null, view())).toEqual({ kind: 'none' });
  });
});

describe('babyPreparer', () => {
  const ada = baby('Ada', '2026-09-01T08:00:00.000Z');
  const entry = (babyId: string) => ({ babyId }) as BabyEvent;

  test('adds an unknown baby once, before its first push', async () => {
    const added: Baby[] = [];
    const known = new Set<string>();
    const prepare = babyPreparer(
      async (b) => added.push(b),
      known,
      () => ada,
    );
    await prepare([entry(ada.id)]);
    await prepare([entry(ada.id)]);
    expect(added).toEqual([ada]);
    expect(known.has(ada.id)).toBe(true);
  });

  test('skips a known baby and batches without its entries', async () => {
    let calls = 0;
    const add = async () => void calls++;
    await babyPreparer(add, new Set([ada.id]), () => ada)([entry(ada.id)]);
    await babyPreparer(add, new Set(), () => ada)([entry(newId())]);
    await babyPreparer(add, new Set(), () => null)([entry(ada.id)]);
    expect(calls).toBe(0);
  });

  test('a failed add throws, so the push waits and nothing is marked known', async () => {
    const known = new Set<string>();
    const prepare = babyPreparer(
      () => Promise.reject(new Error('offline')),
      known,
      () => ada,
    );
    await expect(prepare([entry(ada.id)])).rejects.toThrow('offline');
    expect(known.size).toBe(0);
  });
});

describe('inviteCode', () => {
  test('accepts the code as typed or read aloud', () => {
    expect(inviteCode('7k2m9-qx4ab')).toBe('7K2M9QX4AB');
    expect(inviteCode(' 7K2M9 QX4AB ')).toBe('7K2M9QX4AB');
    expect(inviteCode('OIL0000000')).toBe('0110000000');
  });

  test('rejects anything that is not ten Crockford characters', () => {
    expect(inviteCode('')).toBeNull();
    expect(inviteCode('7K2M9QX4A')).toBeNull();
    expect(inviteCode('7K2M9QX4AU')).toBeNull();
    expect(inviteCode('7K2M9QX4AB1')).toBeNull();
  });
});
