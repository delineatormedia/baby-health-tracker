import type { DatabaseSync } from 'node:sqlite';
import { sessionLive, type Session } from './auth.ts';

/** The 409 a baby deleted by a clear gets when a phone tries to add it again. */
export { BABY_CLEARED } from '@bht/schema';

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
 * Two things keep the old data from coming back. Revoking the sessions: a phone that was
 * offline through the clear still holds its copy, but every request it makes from now on is
 * refused until it signs in again, and the app drops the copy on that refusal. And the ids of
 * the deleted babies are kept (cleared_babies): a phone that signed out before the clear and
 * signs in after cannot add its old baby back, so its old entries have nowhere to land. A
 * watermark from before the clear would vouch for windows of a log that no longer exists, so
 * those go too.
 *
 * Null, and nothing changed, if the caller's session is no longer live (sessionLive): a phone
 * signed out by an earlier clear cannot clear what the household has entered since.
 *
 * Everything commits together or not at all, so a crash partway leaves the household as it
 * was and the parent retries. After the commit the WAL is checkpointed and truncated, so with
 * secure_delete (db.ts) the deleted rows are not left in the database files. Backups taken
 * before the clear still hold them (docs/DEPLOY.md).
 */
export function clearHousehold(
  db: DatabaseSync,
  session: Session,
  now = new Date(),
): ClearOutcome | null {
  const { householdId } = session;
  const clearedAt = now.toISOString();
  const members = 'SELECT id FROM members WHERE household_id = ?';
  let outcome: ClearOutcome;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!sessionLive(db, session, now)) {
      db.exec('ROLLBACK');
      return null;
    }
    if (db.prepare('SELECT 1 FROM households WHERE id = ?').get(householdId) === undefined) {
      throw new Error(`No household ${householdId}`);
    }
    const versions = db
      .prepare('DELETE FROM event_versions WHERE household_id = ?')
      .run(householdId).changes;
    db.prepare(
      `INSERT OR IGNORE INTO cleared_babies (id, household_id, cleared_at)
       SELECT id, household_id, ? FROM babies WHERE household_id = ?`,
    ).run(clearedAt, householdId);
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
