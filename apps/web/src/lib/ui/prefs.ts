import { newId, parseBaby, type Baby, type Id, type VolumeDisplay } from '@bht/schema';

// Same pattern as Id in @bht/schema.
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

// Per-phone settings in localStorage. The baby and this phone's author id live here too until
// household sign-in (#6c) moves them to the server.

export type Theme = 'auto' | 'night' | 'light';

export interface Prefs {
  volume: VolumeDisplay;
  theme: Theme;
  /**
   * "Day starts at" (#21), minutes after midnight. Groups Reports into days; Readings never
   * read it. Per phone until household sync (#5) can share it.
   */
  dayStart: number;
}

export const DEFAULT_PREFS: Prefs = { volume: 'ml', theme: 'auto', dayStart: 0 };

const VOLUMES: readonly VolumeDisplay[] = ['ml', 'oz', 'both'];
const THEMES: readonly Theme[] = ['auto', 'night', 'light'];

export const KEYS = {
  prefs: 'bht.prefs',
  author: 'bht.author',
  baby: 'bht.baby',
  setupAt: 'bht.setupAt',
  homeNoteDismissed: 'bht.homeNoteDismissed',
  account: 'bht.account',
  joining: 'bht.joining',
} as const;

type KV = Pick<Storage, 'getItem' | 'setItem'>;
type KVRemove = KV & Pick<Storage, 'removeItem'>;

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
    dayStart: isDayStart(o.dayStart) ? o.dayStart : DEFAULT_PREFS.dayStart,
  };
}

/** Whole minutes from midnight up to 11:59 PM. */
export const isDayStart = (x: unknown): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1440;

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

/**
 * Replaces this phone's author id with a fresh one (#5 step 3): the server refused the old
 * one at sign-in, as a removed phone or another household's. Entries already logged keep
 * the id they were logged under.
 */
export function mintAuthorId(kv: KV): Id {
  const id = newId();
  kv.setItem(KEYS.author, id);
  return id;
}

/** The household this phone signed in to; the session itself is an HttpOnly cookie. */
export interface StoredAccount {
  householdId: Id;
  memberId: Id;
  /** False from sign-in until the household has loaded and this phone's baby is placed. */
  placed?: false;
}

export function loadAccount(kv: KV): StoredAccount | null {
  const raw = readJson(kv, KEYS.account) as Partial<StoredAccount> | null;
  const ok = (x: unknown): x is Id => typeof x === 'string' && ULID.test(x);
  if (!raw || !ok(raw.householdId) || !ok(raw.memberId)) return null;
  const { householdId, memberId } = raw;
  return raw.placed === false
    ? { householdId, memberId, placed: false }
    : { householdId, memberId };
}

export function saveAccount(kv: KVRemove, account: StoredAccount | null): void {
  if (account) kv.setItem(KEYS.account, JSON.stringify(account));
  else kv.removeItem(KEYS.account);
}

/**
 * The household baby a signed-in phone still has to choose about (#5 step 3): its own baby
 * is not in the household, so its entries are moved or kept off first. Written before the
 * account, cleared once the move or archive commits; a reload in between asks again.
 */
export function loadJoining(kv: KV): Baby | null {
  return parseBaby(readJson(kv, KEYS.joining));
}

export function saveJoining(kv: KVRemove, baby: Baby | null): void {
  const parsed = baby && parseBaby(baby);
  if (baby && !parsed) throw new Error('Invalid baby');
  if (parsed) kv.setItem(KEYS.joining, JSON.stringify(parsed));
  else kv.removeItem(KEYS.joining);
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

/** The Add to Home Screen note (#42) stays dismissed on this phone. */
export const loadHomeNoteDismissed = (kv: KV): boolean =>
  kv.getItem(KEYS.homeNoteDismissed) === '1';

export function saveHomeNoteDismissed(kv: KV): void {
  kv.setItem(KEYS.homeNoteDismissed, '1');
}
