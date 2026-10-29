import { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order. PRAGMA user_version records how many have run. Append
 * only: a migration that has shipped is never edited.
 */
export const MIGRATIONS: string[] = [
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
  // 2: members and passkeys, the household's babies, phones, invites and sessions (#5 step
  // 2). Invite codes, session tokens and flow secrets are stored as SHA-256 hashes, never as
  // issued.
  // event_versions.member_id is the signed-in member who pushed a version, stamped by the
  // server; it is null on versions stored before this migration.
  `CREATE TABLE members (
     id TEXT PRIMARY KEY,
     household_id TEXT NOT NULL REFERENCES households (id),
     display_name TEXT NOT NULL,
     webauthn_user_id TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL
   ) STRICT;
   CREATE TABLE credentials (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL REFERENCES members (id),
     public_key BLOB NOT NULL,
     counter INTEGER NOT NULL,
     transports TEXT NOT NULL,
     created_at TEXT NOT NULL,
     last_used_at TEXT
   ) STRICT;
   CREATE TABLE babies (
     id TEXT PRIMARY KEY,
     household_id TEXT NOT NULL REFERENCES households (id),
     name TEXT NOT NULL,
     birth_at TEXT NOT NULL,
     sex TEXT NOT NULL,
     created_at TEXT NOT NULL
   ) STRICT;
   CREATE INDEX babies_by_household ON babies (household_id);
   CREATE TABLE devices (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL REFERENCES members (id),
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     removed_at TEXT
   ) STRICT;
   CREATE TABLE invites (
     code_hash TEXT PRIMARY KEY,
     household_id TEXT NOT NULL REFERENCES households (id),
     created_by TEXT NOT NULL REFERENCES members (id),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     used_at TEXT,
     used_by TEXT REFERENCES members (id)
   ) STRICT;
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     member_id TEXT NOT NULL REFERENCES members (id),
     device_id TEXT NOT NULL REFERENCES devices (id),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT
   ) STRICT;
   CREATE TABLE auth_flows (
     id TEXT PRIMARY KEY,
     challenge TEXT NOT NULL,
     purpose TEXT NOT NULL,
     payload TEXT NOT NULL,
     browser_hash TEXT NOT NULL,
     expires_at TEXT NOT NULL
   ) STRICT;
   ALTER TABLE event_versions ADD COLUMN member_id TEXT REFERENCES members (id);`,
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

/**
 * Creates a household and its babies if they do not exist yet, for tests that inject a
 * session. In production a household is created by the first member's passkey registration.
 */
export function ensureHousehold(
  db: DatabaseSync,
  id: string,
  babyIds: readonly string[] = [],
  now = new Date(),
): void {
  const at = now.toISOString();
  db.prepare('INSERT OR IGNORE INTO households (id, created_at) VALUES (?, ?)').run(id, at);
  const baby = db.prepare(
    `INSERT OR IGNORE INTO babies (id, household_id, name, birth_at, sex, created_at)
     VALUES (?, ?, 'Test baby', ?, 'unspecified', ?)`,
  );
  for (const b of babyIds) baby.run(b, id, at, at);
}
