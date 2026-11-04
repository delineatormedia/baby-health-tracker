import { newId, type ClearId, type ClearMarker } from '@bht/schema';
import type { DatabaseSync } from 'node:sqlite';

// Clearing a household's data (#85): the server deletes the babies and every stored version,
// and from then on refuses any request from a phone that has not seen the clear.

/** The 409 text every refused request carries; the body's `cleared` is the current marker. */
export const CLEARED = 'This household’s data was cleared; the app drops its copy and syncs again';

/**
 * Thrown inside a sync transaction when the request's marker is not the household's. The
 * route answers 409 `{error, cleared}`, and the transaction rolls back, so nothing is written.
 */
export class Cleared extends Error {
  constructor(readonly cleared: ClearId) {
    super(CLEARED);
  }
}

/** The household's current clear marker: null until its first clear. */
export function currentClear(db: DatabaseSync, householdId: string): ClearId {
  const row = db.prepare('SELECT clear_id FROM households WHERE id = ?').get(householdId) as
    { clear_id: string | null } | undefined;
  return row?.clear_id ?? null;
}

/**
 * Throws Cleared unless `sent`, the request's marker, is the household's. A request without
 * one (an app from before #85) counts as holding null, so it keeps working until the first
 * clear and is refused from then on until the app updates. Call it inside the transaction
 * that reads or writes, so a clear committing meanwhile is seen. Returns the marker.
 */
export function checkClear(db: DatabaseSync, householdId: string, sent: ClearMarker): ClearId {
  const current = currentClear(db, householdId);
  if ((sent ?? null) !== current) throw new Cleared(current);
  return current;
}

export interface ClearOutcome {
  clearId: string;
  clearedAt: string;
  /** Rows deleted, for the server log. */
  babies: number;
  versions: number;
}

/**
 * Deletes the household's babies and every version of their entries, in one transaction with
 * the new marker, and resets its phones' watermarks: an old watermark would vouch for windows
 * of a log that no longer exists. The household, its members, passkeys, phones, sessions and
 * invites stay. `expected` is the caller's marker: when it is not the current one the caller
 * has not seen the latest clear, and nothing is deleted (`ok: false`, with the current marker).
 *
 * Everything commits together or not at all, so a crash partway leaves the household as it
 * was and the parent retries. After the commit the WAL is checkpointed and truncated, so with
 * secure_delete (db.ts) the deleted rows are not left in the database files. Backups taken
 * before the clear still hold them (docs/DEPLOY.md).
 */
export function clearHousehold(
  db: DatabaseSync,
  householdId: string,
  expected: ClearId,
  now = new Date(),
): { ok: true; value: ClearOutcome } | { ok: false; cleared: ClearId } {
  const clearId = newId();
  const clearedAt = now.toISOString();
  let versions: number;
  let babies: number;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = currentClear(db, householdId);
    if (current !== expected) {
      db.exec('ROLLBACK');
      return { ok: false, cleared: current };
    }
    versions = Number(
      db.prepare('DELETE FROM event_versions WHERE household_id = ?').run(householdId).changes,
    );
    babies = Number(
      db.prepare('DELETE FROM babies WHERE household_id = ?').run(householdId).changes,
    );
    db.prepare(
      `UPDATE devices SET watermark = NULL, gen = NULL
       WHERE member_id IN (SELECT id FROM members WHERE household_id = ?)`,
    ).run(householdId);
    const updated = db
      .prepare('UPDATE households SET clear_id = ?, cleared_at = ? WHERE id = ?')
      .run(clearId, clearedAt, householdId).changes;
    if (updated !== 1) throw new Error(`No household ${householdId}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Best effort: a reader holding the WAL open makes this a partial checkpoint, and the next
  // one finishes it. The data is gone from the database either way.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // :memory: databases have no WAL.
  }
  return { ok: true, value: { clearId, clearedAt, babies, versions } };
}
