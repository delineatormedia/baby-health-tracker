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

export const KEYS = {
  prefs: 'bht.prefs',
  author: 'bht.author',
  baby: 'bht.baby',
  setupAt: 'bht.setupAt',
} as const;

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

/**
 * When this phone set up its baby, in ms, or null on installs from before it was recorded.
 * Readings start counting from here or the first logged event, whichever is earlier (#24).
 */
export function loadSetupAt(kv: KV): number | null {
  const v = Number(kv.getItem(KEYS.setupAt));
  return kv.getItem(KEYS.setupAt) !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/** Records the setup time once; later calls keep the first. */
export function markSetup(kv: KV, now: number): number {
  const existing = loadSetupAt(kv);
  if (existing !== null) return existing;
  kv.setItem(KEYS.setupAt, String(now));
  return now;
}
