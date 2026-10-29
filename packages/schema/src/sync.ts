import type { BabyEvent } from './events.ts';

/**
 * One version of an event as a replica holds it. `seq` is the server sequence number, or
 * null for a local version the server has not accepted yet.
 */
export interface StoredVersion {
  seq: number | null;
  event: BabyEvent;
}

/**
 * Orders two versions of the same event; positive when `a` should win.
 *
 * The highest `version` wins. On a tie the version the server accepted first (lower seq)
 * wins, and an unsynced version loses to any synced one, because the server will rank it
 * last when it arrives. Client clocks never decide the winner, so a device with a skewed
 * clock cannot dominate.
 *
 * Two unsynced versions with the same number (possible from two offline tabs) are ordered by
 * their canonical JSON (sorted keys), so the winner depends only on content: never on a clock,
 * property order or arrival order. Two versions with the same server seq must be the same
 * version; differing bodies there are an integrity error.
 */
export function compareVersions(a: StoredVersion, b: StoredVersion): number {
  if (a.event.version !== b.event.version) return a.event.version - b.event.version;
  if (a.seq !== b.seq) {
    if (a.seq === null) return -1;
    if (b.seq === null) return 1;
    return b.seq - a.seq;
  }
  const ca = canonicalJson(a.event);
  const cb = canonicalJson(b.event);
  if (ca === cb) return 0;
  if (a.seq !== null) {
    throw new Error(`Integrity error: seq ${a.seq} holds two bodies for ${a.event.id}`);
  }
  return ca < cb ? 1 : -1;
}

/** JSON with object keys sorted at every level, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

/**
 * The current version of one event: the same answer on every replica holding the same set of
 * versions, whatever order they arrived in. Returns undefined for an empty list. A deleted
 * winner means the event is deleted; losing versions stay in the log and can be restored.
 */
export function resolveCurrent(versions: readonly StoredVersion[]): StoredVersion | undefined {
  let best: StoredVersion | undefined;
  for (const v of versions) {
    if (best && v.event.id !== best.event.id) {
      throw new Error(`resolveCurrent got versions of ${best.event.id} and ${v.event.id}`);
    }
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/** Current version of every event in a log, keyed by event id. */
export function resolveAll(versions: Iterable<StoredVersion>): Map<string, StoredVersion> {
  const current = new Map<string, StoredVersion>();
  for (const v of versions) {
    const best = current.get(v.event.id);
    if (!best || compareVersions(v, best) > 0) current.set(v.event.id, v);
  }
  return current;
}
