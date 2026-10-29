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
 * clock cannot dominate. The final recordedAt/JSON comparisons only make the order total
 * for impossible inputs (two unsynced versions with the same number).
 */
export function compareVersions(a: StoredVersion, b: StoredVersion): number {
  if (a.event.version !== b.event.version) return a.event.version - b.event.version;
  if (a.seq !== b.seq) {
    if (a.seq === null) return -1;
    if (b.seq === null) return 1;
    return b.seq - a.seq;
  }
  if (a.event.recordedAt !== b.event.recordedAt) {
    return a.event.recordedAt < b.event.recordedAt ? 1 : -1;
  }
  const ja = JSON.stringify(a.event);
  const jb = JSON.stringify(b.event);
  return ja === jb ? 0 : ja < jb ? 1 : -1;
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
