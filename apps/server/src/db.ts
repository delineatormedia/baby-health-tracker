import { DatabaseSync } from 'node:sqlite';

/** Opens the SQLite database and applies pragmas. Pass ':memory:' for tests. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}
