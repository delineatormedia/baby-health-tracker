import * as v from 'valibot';
import type { BabyEvent } from './events.ts';
import { HouseholdDevice } from './protocol.ts';

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
 * last when it arrives. Timestamps never outrank `version` or `seq`, so a device with a skewed
 * clock cannot dominate.
 *
 * Two unsynced versions with the same number (possible from two offline tabs) are ordered by
 * their canonical JSON (sorted keys): a deterministic tiebreak over the whole body, never
 * property order or arrival order. The body includes `occurredAt` and `recordedAt`, so two
 * pending siblings that differ only in a timestamp are ordered by it. That order is
 * provisional: once both reach the server, its sequence decides.
 *
 * A server seq names exactly one stored version. Two different bodies sharing a seq are an
 * integrity error, whatever their versions.
 */
export function compareVersions(a: StoredVersion, b: StoredVersion): number {
  if (a.seq !== null && a.seq === b.seq) {
    if (canonicalJson(a.event) !== canonicalJson(b.event)) throw seqConflict(a.seq);
    return 0;
  }
  if (a.event.version !== b.event.version) return a.event.version - b.event.version;
  if (a.seq !== b.seq) {
    if (a.seq === null) return -1;
    if (b.seq === null) return 1;
    return b.seq - a.seq;
  }
  const ca = canonicalJson(a.event);
  const cb = canonicalJson(b.event);
  if (ca === cb) return 0;
  return ca < cb ? 1 : -1;
}

function seqConflict(seq: number): Error {
  return new Error(`Integrity error: seq ${seq} holds two different bodies`);
}

/**
 * Throws if any server seq in the log holds two different bodies. Checked over the whole log,
 * independently of which version wins, so the result never depends on arrival order.
 */
export function assertSeqIntegrity(versions: Iterable<StoredVersion>): void {
  const bodies = new Map<number, string>();
  for (const v of versions) {
    if (v.seq === null) continue;
    const body = canonicalJson(v.event);
    const seen = bodies.get(v.seq);
    if (seen === undefined) bodies.set(v.seq, body);
    else if (seen !== body) throw seqConflict(v.seq);
  }
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
  assertSeqIntegrity(versions);
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
  const log = [...versions];
  assertSeqIntegrity(log);
  const current = new Map<string, StoredVersion>();
  for (const v of log) {
    const best = current.get(v.event.id);
    if (!best || compareVersions(v, best) > 0) current.set(v.event.id, v);
  }
  return current;
}

/**
 * Whether a pull's device row has the wire shape (step 3b). A client adopts no device list
 * with a bad row: a missing or malformed watermark, removedAt or signedOutAt must never read
 * as synced.
 */
export function isHouseholdDevice(input: unknown): input is HouseholdDevice {
  return v.is(HouseholdDevice, input);
}
