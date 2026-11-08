import type { BabyEvent, ClearId, HouseholdDevice } from '@bht/schema';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * The household's clear marker as this phone holds it (#85), under meta key clear:<household>.
 * Absent until the phone's first placement or pull under #85; then the marker it last adopted,
 * null for "no clear yet". Kept across sign-out: a phone that belonged before a clear must
 * drop its copy when it comes back, and only then.
 */
export interface ClearMark {
  clearId: ClearId;
}

/**
 * A wipe whose IndexedDB side committed and whose localStorage side has not (#85), under meta
 * key wipe:<household>. Written in the transaction that drops the rows, deleted once the
 * stored baby, setup time and notes are gone too. Null markers (a server restored to before
 * its first clear) are wipes like any other; a marker adopted at first placement writes none.
 */
export interface PendingWipe {
  clearId: ClearId;
  /** When the clear ran, epoch ms: the marker's time, or now for a null marker. */
  at: number;
}

/**
 * The clear generation a baby this phone holds belongs to (#85, #95), under meta key
 * baby:<babyId>: the household's marker when the phone took the baby (placed it at sign-in,
 * adopted it after a clear, or added it). Every local write for the baby checks it against the
 * household's current marker in the write's own transaction, and is refused once they differ:
 * the baby went with a clear, whether or not this tab has heard. Written over, never deleted,
 * so a baby taken again (after a sign-in elsewhere, say) carries its new generation.
 */
export interface BabyMark {
  household: string;
  clearId: ClearId;
}

/** One stored version. seq is null until the server accepts it. */
export interface VersionRow {
  key: string;
  id: string;
  babyId: string;
  seq: number | null;
  /** 1 while waiting to be pushed (IndexedDB cannot index booleans or null). */
  pending: 0 | 1;
  /**
   * Set when the server refused this local version: 1, so only refused rows are indexed, and
   * the server's reason. The row is kept, never uploaded again, and counted in Settings.
   */
  rejected?: 1;
  rejectedError?: string;
  /**
   * Set (1) on this phone's pre-join history: earlier versions of an event moved into the
   * household's baby, and every row of an archived baby. Kept and shown, never uploaded.
   */
  localOnly?: 1;
  /** Set (1) with localOnly when the baby was archived at join rather than moved. */
  archived?: 1;
  event: BabyEvent;
}

export interface BhtDB extends DBSchema {
  versions: {
    key: string;
    value: VersionRow;
    indexes: { byId: string; byBaby: string; byPending: number; byRejected: number };
  };
  /**
   * Pull cursors (cursor:<household>), the write generation (gen), each household's adopted
   * device list (devices:<household>), its clear marker (clear:<household>), a wipe still to
   * finish (wipe:<household>), the generation each baby was taken under (baby:<babyId>) and
   * the sign-out flag (signingOut, 1 while set).
   */
  meta: {
    key: string;
    value: number | HouseholdDevice[] | ClearMark | PendingWipe | BabyMark;
  };
}

export type Database = IDBPDatabase<BhtDB>;

export function rowKey(event: BabyEvent, seq: number | null): string {
  return `${event.id}:${event.version}:${seq ?? 'local'}`;
}

export function openDatabase(name = 'bht'): Promise<Database> {
  return openDB<BhtDB>(name, 2, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const versions = db.createObjectStore('versions', { keyPath: 'key' });
        versions.createIndex('byId', 'id');
        versions.createIndex('byBaby', 'babyId');
        versions.createIndex('byPending', 'pending');
        db.createObjectStore('meta');
      }
      // 2: refused versions are kept and counted instead of deleted (#5).
      if (oldVersion < 2) tx.objectStore('versions').createIndex('byRejected', 'rejected');
    },
  });
}
