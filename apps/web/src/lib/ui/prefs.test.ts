import { newId } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  authorId,
  DEFAULT_PREFS,
  KEYS,
  loadBaby,
  loadPrefs,
  saveBaby,
  savePrefs,
} from './prefs.ts';
import { fromLocalInput, toLocalInput } from './time.ts';

function kv(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

describe('prefs', () => {
  test('round-trip, with field-by-field fallback for damage', () => {
    const s = kv();
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
    savePrefs(s, { volume: 'both', theme: 'night' });
    expect(loadPrefs(s)).toEqual({ volume: 'both', theme: 'night' });
    expect(loadPrefs(kv({ [KEYS.prefs]: '{"volume":"cups","theme":"light"}' }))).toEqual({
      volume: 'ml',
      theme: 'light',
    });
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
});
