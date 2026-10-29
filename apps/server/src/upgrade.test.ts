import type { BabyEvent, PullResponse } from '@bht/schema';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { MIGRATIONS, openDatabase } from './db.ts';
import { SoftAuthenticator, type SavedKey } from './testing/authenticator.ts';
import { Phone } from './testing/phone.ts';

/**
 * A family server deployed from main before sync (#63) keeps its database when it is upgraded.
 * The fixture is that build's database, dumped after it registered a household, joined a
 * second parent and stored six event versions; the JSON beside it holds the two phones'
 * passkeys and session cookies, and what main's pull returned.
 */
const ORIGIN = 'https://bht.example.ts.net';
const config = {
  auth: { rpId: 'bht.example.ts.net', origin: ORIGIN, registration: 'first' as const },
  // A day after the fixture's clock, well inside its sessions' lifetime.
  now: () => new Date('2026-10-30T12:00:00.000Z'),
};
const fixtures = join(import.meta.dirname, 'fixtures');
const old = JSON.parse(readFileSync(join(fixtures, 'upgrade-from-main.json'), 'utf8')) as {
  householdId: string;
  babies: string[];
  members: string[];
  phones: Record<'a' | 'b', { deviceId: string; cookie: string; keys: SavedKey[] }>;
  events: BabyEvent[];
  pulled: PullResponse;
};

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true });
  dir = null;
});

/** main's database file, as the owner's server would have it on disk. */
function mainDatabase(): string {
  dir = mkdtempSync(join(tmpdir(), 'bht-upgrade-'));
  const file = join(dir, 'bht.db');
  const db = new DatabaseSync(file);
  db.exec(readFileSync(join(fixtures, 'upgrade-from-main.sql'), 'utf8'));
  db.close();
  return file;
}

const userVersion = (db: DatabaseSync) =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

/** Every row of every table, AUTOINCREMENT's sqlite_sequence included, in rowid order, blobs as hex. */
function rows(db: DatabaseSync): Record<string, Record<string, unknown>[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')`,
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db
        .prepare(`SELECT * FROM ${name} ORDER BY rowid`)
        .all()
        .map((r) =>
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [
              k,
              v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
            ]),
          ),
        ),
    ]),
  );
}

test('the migrations run once on main’s database and keep every row', () => {
  const file = mainDatabase();
  const raw = new DatabaseSync(file);
  expect(userVersion(raw)).toBe(2);
  const before = rows(raw);
  raw.close();
  expect(before.event_versions).toHaveLength(6);
  // As main left it: one sequence row, at the last seq it handed out.
  expect(before.sqlite_sequence).toEqual([{ name: 'event_versions', seq: 6 }]);

  const db = openDatabase(file);
  expect(userVersion(db)).toBe(MIGRATIONS.length);
  // Opening again runs nothing: a second ALTER TABLE ADD COLUMN would throw.
  openDatabase(file).close();
  expect(userVersion(db)).toBe(MIGRATIONS.length);

  // Every inherited row is unchanged column for column; migrations only add columns.
  const after = rows(db);
  for (const [table, oldRows] of Object.entries(before)) {
    const kept = after[table]!.map((r, i) =>
      Object.fromEntries(Object.keys(oldRows[i] ?? r).map((k) => [k, r[k]])),
    );
    expect(kept, table).toEqual(oldRows);
  }
  db.close();
});

test('the household, its passkeys and its event log carry over to the sync build', async () => {
  const db = openDatabase(mainDatabase());
  const app = createApp(db, config);
  const phone = (p: (typeof old.phones)['a']) =>
    new Phone(app, ORIGIN, SoftAuthenticator.load(ORIGIN, p.keys), p.deviceId);
  const a = phone(old.phones.a);
  const b = phone(old.phones.b);

  // The session main issued still signs the phone in.
  a.cookie = old.phones.a.cookie;
  const household = await a.json<{ babies: { id: string }[]; members: { id: string }[] }>(
    '/api/household',
  );
  expect(household.babies.map((x) => x.id).sort()).toEqual([...old.babies].sort());
  expect(household.members.map((x) => x.id).sort()).toEqual([...old.members].sort());

  // Both passkeys sign in again, on the same phones.
  for (const p of [a, b]) {
    p.cookie = null;
    const res = await (await p.ceremony('login', { deviceId: p.deviceId })).verify();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { householdId: string }).householdId).toBe(old.householdId);
  }

  // The log reads back exactly as main served it, and a phone's first sync on the new client
  // (its whole backlog again) stores nothing new.
  const count = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM event_versions').get() as { n: number }).n;
  expect((await a.pull()).versions).toEqual(old.pulled.versions);
  const pushed = await a.push(old.events.filter((e) => e.babyId === old.babies[0]));
  await b.push(old.events.filter((e) => e.babyId === old.babies[1]));
  expect(count()).toBe(6);
  expect((await b.pull()).versions).toEqual(old.pulled.versions);

  // A phone from before barriers existed gets a watermark on its first barrier.
  const barrier = await a.json<{ watermark: number }>('/api/sync/barrier', {
    deviceId: a.deviceId,
    gen: 1,
    at: pushed.serverNow,
  });
  expect(barrier.watermark).toBe(pushed.serverNow);
  db.close();
});
