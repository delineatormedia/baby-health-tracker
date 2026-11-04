import { newId } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  authorId,
  DEFAULT_PREFS,
  KEYS,
  loadAccount,
  loadBaby,
  loadClearedLocal,
  loadClearNotice,
  loadJoining,
  loadPrefs,
  mintAuthorId,
  saveAccount,
  saveBaby,
  saveJoining,
  savePrefs,
  wipeLocal,
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
    savePrefs(s, { volume: 'both', weight: 'lb', theme: 'night', dayStart: 480 });
    expect(loadPrefs(s)).toEqual({ volume: 'both', weight: 'lb', theme: 'night', dayStart: 480 });
    expect(loadPrefs(kv({ [KEYS.prefs]: '{"volume":"cups","theme":"light"}' }))).toEqual({
      volume: 'ml',
      weight: 'g',
      theme: 'light',
      dayStart: 0,
    });
    for (const bad of [-1, 1440, 7.5, '480', null]) {
      expect(loadPrefs(kv({ [KEYS.prefs]: JSON.stringify({ dayStart: bad }) })).dayStart).toBe(0);
    }
    expect(loadPrefs(kv({ [KEYS.prefs]: 'not json' }))).toEqual(DEFAULT_PREFS);
    // Weight unit (#84): damaged values fall back to grams.
    for (const bad of ['kg', 'lb_oz', 'LB', 1, null]) {
      expect(loadPrefs(kv({ [KEYS.prefs]: JSON.stringify({ weight: bad }) })).weight).toBe('g');
    }
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

  test('an unplaced account keeps its flag; a placed one has none', () => {
    const s = kv();
    const ids = { householdId: newId(), memberId: newId() };
    saveAccount(s, { ...ids, placed: false });
    expect(loadAccount(s)).toEqual({ ...ids, placed: false });
    saveAccount(s, ids);
    expect(loadAccount(s)).toEqual(ids);
    expect(loadAccount(kv({ [KEYS.account]: JSON.stringify({ ...ids, placed: true }) }))).toEqual(
      ids,
    );
  });

  test('the household baby waiting on the join choice round-trips and clears', () => {
    const s = kv();
    expect(loadJoining(s)).toBeNull();
    const baby = {
      id: newId(),
      householdId: newId(),
      name: 'Ada',
      birthAt: '2026-10-01T08:00:00.000Z',
      sex: 'female' as const,
    };
    saveJoining(s, baby);
    expect(loadJoining(s)).toEqual(baby);
    saveJoining(s, null);
    expect(s.m.has(KEYS.joining)).toBe(false);
    expect(() => saveJoining(s, { ...baby, name: '' })).toThrow('Invalid baby');
  });
});

describe('the localStorage side of a clear (#85)', () => {
  test('wipeLocal drops the baby, setup time, join and late notes, keeps the rest, and records the marker', () => {
    const household = newId();
    const clearId = newId();
    const store = kv({
      'bht.baby': '{"id":"x"}',
      'bht.setupAt': '1700000000000',
      'bht.joining': '{"id":"y"}',
      [`bht.late.${household}`]: '[]',
      [`bht.late.${newId()}`]: '[]',
      'bht.prefs': '{"theme":"night"}',
      'bht.author': 'a',
      'bht.account': '{"householdId":"h"}',
      'bht.homeNoteDismissed': '1',
    });
    expect(loadClearedLocal(store)).toBeNull();
    expect(loadClearNotice(store)).toBeNull();

    wipeLocal(store, household, clearId, 1_750_000_000_000);
    expect([...store.m.keys()].sort()).toEqual(
      [
        `bht.late.${[...store.m.keys()].find((k) => k.startsWith('bht.late.'))!.slice(9)}`,
        'bht.prefs',
        'bht.author',
        'bht.account',
        'bht.homeNoteDismissed',
        KEYS.cleared,
        KEYS.clearNotice,
      ].sort(),
    );
    expect(store.m.has(`bht.late.${household}`)).toBe(false);
    expect(loadClearedLocal(store)).toBe(clearId);
    expect(loadClearNotice(store)).toEqual({ clearId, at: 1_750_000_000_000 });

    // A restore that took the server back before its first clear: the marker is null again.
    wipeLocal(store, household, null, 1_760_000_000_000);
    expect(loadClearedLocal(store)).toBeNull();
    expect(loadClearNotice(store)).toEqual({ clearId: null, at: 1_760_000_000_000 });
  });

  test('damaged values read as none', () => {
    expect(loadClearedLocal(kv({ [KEYS.cleared]: 'not-a-ulid' }))).toBeNull();
    expect(loadClearNotice(kv({ [KEYS.clearNotice]: '{"clearId":"x","at":1}' }))).toBeNull();
    expect(loadClearNotice(kv({ [KEYS.clearNotice]: '{"clearId":null,"at":"soon"}' }))).toBeNull();
    expect(loadClearNotice(kv({ [KEYS.clearNotice]: 'nope' }))).toBeNull();
  });
});
