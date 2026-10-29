import { newId } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  authorId,
  DEFAULT_PREFS,
  KEYS,
  loadAccount,
  loadBaby,
  loadPrefs,
  mintAuthorId,
  saveAccount,
  saveBaby,
  savePrefs,
} from './prefs.ts';
import { fromLocalInput, toLocalInput } from './time.ts';

function kv(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

describe('prefs', () => {
  test('round-trip, with field-by-field fallback for damage', () => {
    const s = kv();
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
    savePrefs(s, { volume: 'both', theme: 'night', dayStart: 480 });
    expect(loadPrefs(s)).toEqual({ volume: 'both', theme: 'night', dayStart: 480 });
    expect(loadPrefs(kv({ [KEYS.prefs]: '{"volume":"cups","theme":"light"}' }))).toEqual({
      volume: 'ml',
      theme: 'light',
      dayStart: 0,
    });
    for (const bad of [-1, 1440, 7.5, '480', null]) {
      expect(loadPrefs(kv({ [KEYS.prefs]: JSON.stringify({ dayStart: bad }) })).dayStart).toBe(0);
    }
    expect(loadPrefs(kv({ [KEYS.prefs]: 'not json' }))).toEqual(DEFAULT_PREFS);
  });

  test('the author id is minted once and replaced only if invalid', () => {
    const s = kv();
    const a = authorId(s);
    expect(authorId(s)).toBe(a);
    expect(authorId(kv({ [KEYS.author]: 'nope' }))).not.toBe('nope');
  });

  test('baby is validated on load and save', () => {
    const s = kv();
    const baby = {
      id: newId(),
      householdId: newId(),
      name: 'Test',
      birthAt: '2026-10-17T10:42:00.000Z',
      sex: 'female' as const,
    };
    saveBaby(s, baby);
    expect(loadBaby(s)).toEqual(baby);
    expect(loadBaby(kv({ [KEYS.baby]: '{"name":"x"}' }))).toBeNull();
    expect(() => saveBaby(s, { ...baby, name: '' })).toThrow();
  });
});

describe('datetime-local', () => {
  test('round-trips local wall time through UTC', () => {
    const ms = new Date(2026, 9, 29, 2, 59).getTime();
    expect(toLocalInput(ms)).toBe('2026-10-29T02:59');
    expect(fromLocalInput('2026-10-29T02:59')).toBe(new Date(ms).toISOString());
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('2026-13-40T99:99')).toBeNull();
  });

  test('minting replaces the author id, and later reads keep the new one', () => {
    const s = kv();
    const first = authorId(s);
    const minted = mintAuthorId(s);
    expect(minted).not.toBe(first);
    expect(authorId(s)).toBe(minted);
  });

  test('the stored account round-trips, clears, and ignores damage', () => {
    const s = kv();
    expect(loadAccount(s)).toBeNull();
    const account = { householdId: newId(), memberId: newId() };
    saveAccount(s, account);
    expect(loadAccount(s)).toEqual(account);
    saveAccount(s, null);
    expect(s.m.has(KEYS.account)).toBe(false);
    for (const bad of ['not json', '{"householdId":"x","memberId":"y"}', '[]', 'null']) {
      expect(loadAccount(kv({ [KEYS.account]: bad }))).toBeNull();
    }
  });
});
