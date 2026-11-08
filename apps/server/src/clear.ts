import type { DatabaseSync } from 'node:sqlite';

// Clearing a household's data (#85): the server deletes the babies and every stored version,
// and signs every phone out. A phone that has not heard yet finds out on its next request: the
// session is gone, so it gets 401, drops its own copy and goes back to the welcome screen.

export interface ClearOutcome {
  clearedAt: string;
  /** Rows deleted or revoked, for the server log. */
  babies: number;
  versions: number;
  sessions: number;
}

/**
 * Deletes the household's babies and every version of their entries, revokes every one of its
 * sessions and resets its phones' watermarks, in one transaction. The household, its members,
 * passkeys, phones and invites stay, so everyone signs back in and starts over.
 *
 * Revoking the sessions is what keeps the old data from coming back: a phone that was offline
 * through the clear still holds its copy, but every request it makes from now on is refused
 * until it signs in again, and the app drops the copy on that refusal. A watermark from before
 * the clear would vouch for windows of a log that no longer exists, so those go too.
 *
 * Everything commits together or not at all, so a crash partway leaves the household as it
 * was and the parent retries. After the commit the WAL is checkpointed and truncated, so with
 * secure_delete (db.ts) the deleted rows are not left in the database files. Backups taken
 * before the clear still hold them (docs/DEPLOY.md).
 */
export function clearHousehold(
  db: DatabaseSync,
  householdId: string,
  now = new Date(),
): ClearOutcome {
  const clearedAt = now.toISOString();
  const members = 'SELECT id FROM members WHERE household_id = ?';
  let outcome: ClearOutcome;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM households WHERE id = ?').get(householdId) === undefined) {
      throw new Error(`No household ${householdId}`);
    }
    const versions = db
      .prepare('DELETE FROM event_versions WHERE household_id = ?')
      .run(householdId).changes;
    const babies = db.prepare('DELETE FROM babies WHERE household_id = ?').run(householdId).changes;
    db.prepare(
      `UPDATE devices SET watermark = NULL, gen = NULL WHERE member_id IN (${members})`,
    ).run(householdId);
    const sessions = db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
         WHERE revoked_at IS NULL AND member_id IN (${members})`,
      )
      .run(clearedAt, householdId).changes;
    db.exec('COMMIT');
    outcome = {
      clearedAt,
      babies: Number(babies),
      versions: Number(versions),
      sessions: Number(sessions),
    };
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
  return outcome;
}
