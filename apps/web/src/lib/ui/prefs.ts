import { newId, parseBaby, type Baby, type Id, type VolumeDisplay } from '@bht/schema';

// Same pattern as Id in @bht/schema.
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

// Per-phone settings in localStorage. The baby and this phone's author id live here too until
// household sign-in (#6c) moves them to the server.

export type Theme = 'auto' | 'night' | 'light';

export interface Prefs {
  volume: VolumeDisplay;
  theme: Theme;
}

export const DEFAULT_PREFS: Prefs = { volume: 'ml', theme: 'auto' };

const VOLUMES: readonly VolumeDisplay[] = ['ml', 'oz', 'both'];
const THEMES: readonly Theme[] = ['auto', 'night', 'light'];

export const KEYS = { prefs: 'bht.prefs', author: 'bht.author', baby: 'bht.baby' } as const;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function readJson(kv: KV, key: string): unknown {
  try {
    return JSON.parse(kv.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

/** Unknown or damaged values fall back field by field to the defaults. */
export function loadPrefs(kv: KV): Prefs {
  const raw = readJson(kv, KEYS.prefs);
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    volume: VOLUMES.find((x) => x === o.volume) ?? DEFAULT_PREFS.volume,
    theme: THEMES.find((x) => x === o.theme) ?? DEFAULT_PREFS.theme,
  };
}

export function savePrefs(kv: KV, prefs: Prefs): void {
  kv.setItem(KEYS.prefs, JSON.stringify(prefs));
}

/** This phone's author id, minted once. Events record who logged them. */
export function authorId(kv: KV): Id {
  const existing = kv.getItem(KEYS.author);
  if (existing && ULID.test(existing)) return existing;
  const id = newId();
  kv.setItem(KEYS.author, id);
  return id;
}

export function loadBaby(kv: KV): Baby | null {
  return parseBaby(readJson(kv, KEYS.baby));
}

export function saveBaby(kv: KV, baby: Baby): void {
  const parsed = parseBaby(baby);
  if (!parsed) throw new Error('Invalid baby');
  kv.setItem(KEYS.baby, JSON.stringify(parsed));
}

/** Stand-in when localStorage is unavailable at module load. */
export function memoryStorage(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, val) => void m.set(k, val) };
}
