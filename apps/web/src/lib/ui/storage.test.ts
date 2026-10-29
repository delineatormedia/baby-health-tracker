import { describe, expect, test, vi } from 'vitest';
import { KEYS, loadHomeNoteDismissed, saveHomeNoteDismissed } from './prefs.ts';
import { ensurePersisted, isStandalone, showHomeScreenNote } from './storage.ts';

const media = (standalone: boolean) => (q: string) => ({
  matches: standalone && q === '(display-mode: standalone)',
});

describe('isStandalone (#42)', () => {
  test('display-mode standalone or iOS navigator.standalone', () => {
    expect(isStandalone({ matchMedia: media(true), navigator: {} })).toBe(true);
    expect(isStandalone({ matchMedia: media(false), navigator: { standalone: true } })).toBe(true);
    // iOS reports navigator.standalone even where display-mode isn't matched.
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
  });

  test('a browser tab is not standalone', () => {
    expect(isStandalone({ matchMedia: media(false), navigator: {} })).toBe(false);
    expect(isStandalone({ matchMedia: media(false), navigator: { standalone: false } })).toBe(
      false,
    );
    expect(isStandalone({})).toBe(false);
    const throws = () => {
      throw new Error('no media queries');
    };
    expect(isStandalone({ matchMedia: throws })).toBe(false);
  });
});

describe('ensurePersisted (#42)', () => {
  const manager = (persisted: boolean, grant = true) => ({
    persisted: vi.fn(async () => persisted),
    persist: vi.fn(async () => grant),
  });

  test('from the Home Screen it asks once when storage is not yet persisted', async () => {
    const m = manager(false);
    expect(await ensurePersisted(m, true)).toBe('persisted');
    expect(m.persist).toHaveBeenCalledTimes(1);
    const refused = manager(false, false);
    expect(await ensurePersisted(refused, true)).toBe('not-persisted');
  });

  test('already persisted: no request', async () => {
    const m = manager(true);
    expect(await ensurePersisted(m, true)).toBe('persisted');
    expect(m.persist).not.toHaveBeenCalled();
  });

  test('a browser tab reports the state but never asks', async () => {
    const m = manager(false);
    expect(await ensurePersisted(m, false)).toBe('not-persisted');
    expect(m.persist).not.toHaveBeenCalled();
  });

  test('no StorageManager, or one that throws, is unknown', async () => {
    expect(await ensurePersisted(undefined, true)).toBe('unknown');
    expect(await ensurePersisted({}, true)).toBe('unknown');
    const broken = {
      persisted: async () => {
        throw new Error('SecurityError');
      },
    };
    expect(await ensurePersisted(broken, true)).toBe('unknown');
  });
});

describe('Add to Home Screen note (#42)', () => {
  test('shows after setup in a browser tab until dismissed', () => {
    expect(showHomeScreenNote({ hasBaby: true, standalone: false, dismissed: false })).toBe(true);
    expect(showHomeScreenNote({ hasBaby: false, standalone: false, dismissed: false })).toBe(false);
    expect(showHomeScreenNote({ hasBaby: true, standalone: true, dismissed: false })).toBe(false);
    expect(showHomeScreenNote({ hasBaby: true, standalone: false, dismissed: true })).toBe(false);
  });

  test('dismissal is stored on this phone', () => {
    const m = new Map<string, string>();
    const kv = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    expect(loadHomeNoteDismissed(kv)).toBe(false);
    saveHomeNoteDismissed(kv);
    expect(m.get(KEYS.homeNoteDismissed)).toBe('1');
    expect(loadHomeNoteDismissed(kv)).toBe(true);
  });
});
