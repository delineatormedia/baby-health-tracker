import type { BabyEvent } from '@bht/schema';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

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
  event: BabyEvent;
}

export interface BhtDB extends DBSchema {
  versions: {
    key: string;
    value: VersionRow;
    indexes: { byId: string; byBaby: string; byPending: number; byRejected: number };
  };
  meta: { key: string; value: number };
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
