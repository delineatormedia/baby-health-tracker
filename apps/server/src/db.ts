import { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order. PRAGMA user_version records how many have run. Append
 * only: a migration that has shipped is never edited.
 */
const MIGRATIONS: string[] = [
  // 1: households and the event log (#5). Every stored version keeps its exact body; seq is
  // the server's order and never reused (AUTOINCREMENT), so a pull cursor never skips one.
  `CREATE TABLE households (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL
   ) STRICT;
   CREATE TABLE event_versions (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     household_id TEXT NOT NULL REFERENCES households (id),
     event_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     baby_id TEXT NOT NULL,
     body TEXT NOT NULL,
     received_at TEXT NOT NULL,
     UNIQUE (event_id, version, body)
   ) STRICT;
   CREATE INDEX event_versions_by_household ON event_versions (household_id, seq);`,
];

/** Opens the SQLite database, applies pragmas and runs pending migrations. ':memory:' for tests. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: done } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (done > MIGRATIONS.length) {
    throw new Error(`Database is at migration ${done}; this server knows ${MIGRATIONS.length}`);
  }
  for (let i = done; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Creates a household if it does not exist yet. Until passkeys (#5 step 2), tests call this. */
export function ensureHousehold(db: DatabaseSync, id: string, now = new Date()): void {
  db.prepare('INSERT OR IGNORE INTO households (id, created_at) VALUES (?, ?)').run(
    id,
    now.toISOString(),
  );
}
