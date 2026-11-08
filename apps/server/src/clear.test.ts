import { newId, type BabyEvent, type ClearResponse, type Invite } from '@bht/schema';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { Phone, register } from './testing/phone.ts';

// Clearing a household's data (#85): the server deletes it for good and signs every phone out,
// so nothing a phone still holds can come back under the old session.

const ORIGIN = 'https://bht.example.ts.net';
const RP_ID = 'bht.example.ts.net';
const T0 = Date.parse('2026-10-29T03:00:00.000Z');

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true });
  dir = null;
});

function server(path = ':memory:') {
  const db = openDatabase(path);
  const clock = { t: T0 };
  const log: string[] = [];
  const app = createApp(db, {
    auth: { rpId: RP_ID, origin: ORIGIN },
    now: () => new Date(clock.t),
    log: (line) => log.push(line),
  });
  return { db, app, clock, log };
}

function wet(babyId: string, authorId = newId(), notes: string | null = null): BabyEvent {
  return {
    id: newId(),
    babyId,
    authorId,
    occurredAt: '2026-10-29T02:00:00.000Z',
    recordedAt: '2026-10-29T02:00:00.000Z',
    version: 1,
    deleted: false,
    notes,
    type: 'diaper',
    data: { kind: 'wet' },
  };
}

const count = (db: DatabaseSync, table: string, household: string) =>
  (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE household_id = ?`).get(household) as {
      n: number;
    }
  ).n;

const liveSessions = (db: DatabaseSync, household: string) =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions s JOIN members m ON m.id = s.member_id
         WHERE m.household_id = ? AND s.revoked_at IS NULL`,
      )
      .get(household) as { n: number }
  ).n;

const clear = (phone: Phone) => phone.request('/api/household/clear', {});
const clearOk = (phone: Phone) => phone.json<ClearResponse>('/api/household/clear', {});

/** The other parent's phone: it joins with an invite and makes one entry of its own. */
async function joined(app: ReturnType<typeof server>['app'], inviter: Phone, babyId: string) {
  const { code } = await inviter.json<Invite>('/api/invites', {});
  const phone = new Phone(app, ORIGIN);
  const { verify } = await phone.ceremony('join', {
    code,
    displayName: 'Sam',
    deviceId: phone.deviceId,
  });
  expect((await verify()).status).toBe(200);
  const entry = wet(babyId, phone.deviceId);
  await phone.push([entry]);
  return { phone, entry };
}

/** A household with two babies, three versions of entries, and a watermark on its phone. */
async function filled(app: ReturnType<typeof server>['app']) {
  const { phone, home, signedIn } = await register(app, ORIGIN);
  const second = { id: newId(), name: 'Wren', birthAt: '2026-10-25T10:00:00.000Z', sex: 'male' };
  await phone.json('/api/babies', second);
  const first = wet(home.baby.id, phone.deviceId);
  const edited = { ...first, version: 2, notes: 'edited' };
  const { serverNow } = await phone.push([first, edited, wet(second.id, phone.deviceId)]);
  await phone.json('/api/sync/barrier', { deviceId: phone.deviceId, gen: 3, at: serverNow });
  return { phone, home, second, memberId: signedIn.memberId };
}

describe('POST /api/household/clear', () => {
  test('deletes the household’s babies and every version, old ones included; the other household is untouched', async () => {
    const { db, app, log } = server();
    const { phone, home, memberId } = await filled(app);
    const other = await register(app, ORIGIN);
    await other.phone.push([wet(other.home.baby.id, other.phone.deviceId)]);
    expect(count(db, 'babies', home.householdId)).toBe(2);
    expect(count(db, 'event_versions', home.householdId)).toBe(3);

    const res = await clear(phone);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clearedAt: new Date(T0).toISOString() });
    // The caller's cookie goes with its session.
    expect(res.headers.getSetCookie().some((c) => c.startsWith('bht_session=;'))).toBe(true);
    expect(count(db, 'babies', home.householdId)).toBe(0);
    expect(count(db, 'event_versions', home.householdId)).toBe(0);
    expect(count(db, 'babies', other.home.householdId)).toBe(1);
    expect(count(db, 'event_versions', other.home.householdId)).toBe(1);
    // The household, its member and its phone stay; the watermark does not.
    expect(count(db, 'members', home.householdId)).toBe(1);
    expect(
      db.prepare('SELECT watermark, gen FROM devices WHERE id = ?').get(phone.deviceId),
    ).toEqual({
      watermark: null,
      gen: null,
    });
    // One line for the operator, with ids and counts and no data.
    expect(log).toEqual([
      `household ${home.householdId} cleared at ${new Date(T0).toISOString()} by member ` +
        `${memberId}: 2 babies and 3 event versions deleted, 1 sessions revoked`,
    ]);
  });

  test('needs a session', async () => {
    const { app } = server();
    const phone = new Phone(app, ORIGIN);
    expect((await clear(phone)).status).toBe(401);
  });

  test('a fault partway leaves every row and every session; the retry then clears', async () => {
    const { db, app } = server();
    const { phone, home } = await filled(app);
    // The last statement of the transaction fails, as a crash there would.
    db.exec(
      `CREATE TRIGGER fault BEFORE UPDATE OF revoked_at ON sessions
       BEGIN SELECT RAISE(ABORT, 'disk gone'); END`,
    );
    app.onError((e, c) => c.json({ error: e.message }, 500));
    expect((await clear(phone)).status).toBe(500);
    expect(count(db, 'babies', home.householdId)).toBe(2);
    expect(count(db, 'event_versions', home.householdId)).toBe(3);
    expect(liveSessions(db, home.householdId)).toBe(1);
    // And the phone's push still works: nothing is half cleared.
    expect((await phone.push([wet(home.baby.id)])).results[0]).toMatchObject({
      status: 'accepted',
    });

    db.exec('DROP TRIGGER fault');
    await clearOk(phone);
    expect(count(db, 'event_versions', home.householdId)).toBe(0);
  });
});

describe('every phone is signed out', () => {
  test('after a clear, every session of the household is refused, so an old upload never lands', async () => {
    const { db, app } = server();
    const { phone, home } = await filled(app);
    const other = await joined(app, phone, home.baby.id);
    const bystander = await register(app, ORIGIN);
    expect(liveSessions(db, home.householdId)).toBe(2);

    await clearOk(phone);
    expect(liveSessions(db, home.householdId)).toBe(0);

    // The other phone was offline through the clear and still holds its log. Its next requests
    // are refused whole, and nothing it sends is stored.
    expect((await other.phone.request('/api/sync?after=0&limit=100')).status).toBe(401);
    const upload = await other.phone.request('/api/sync', {
      schemaVersion: 6,
      events: [other.entry, wet(home.baby.id, other.phone.deviceId)],
    });
    expect(upload.status).toBe(401);
    expect(count(db, 'event_versions', home.householdId)).toBe(0);
    expect(
      (
        await other.phone.request('/api/sync/barrier', {
          deviceId: other.phone.deviceId,
          gen: 9,
          at: T0,
        })
      ).status,
    ).toBe(401);
    expect((await other.phone.request('/api/babies', home.baby)).status).toBe(401);
    // So is the phone that cleared.
    expect((await phone.request('/api/household')).status).toBe(401);
    // Another household's phone is not affected.
    expect((await bystander.phone.request('/api/household')).status).toBe(200);
  });

  test('signing in again works, finds an empty household, and the next baby syncs; a new phone can still join', async () => {
    const { db, app, clock } = server();
    const { phone, home } = await filled(app);
    await clearOk(phone);
    clock.t += 60_000;

    // The same passkey signs the same phone back in.
    const again = new Phone(app, ORIGIN, phone.passkeys, phone.deviceId);
    const { verify } = await again.ceremony('login', { deviceId: again.deviceId });
    expect((await verify()).status).toBe(200);
    expect(await again.json('/api/household')).toMatchObject({ id: home.householdId, babies: [] });

    const next = { id: newId(), name: 'Next', birthAt: '2026-11-01T10:00:00.000Z', sex: 'female' };
    await again.json('/api/babies', next);
    const { results } = await again.push([wet(next.id, again.deviceId)]);
    expect(results[0]).toMatchObject({ status: 'accepted' });
    expect(count(db, 'event_versions', home.householdId)).toBe(1);

    // The other parent joins with a fresh invite and pulls the new log.
    const other = await joined(app, again, next.id);
    const page = await other.phone.pull();
    expect(page.versions.map((v) => v.event.babyId)).toEqual([next.id, next.id]);
  });
});

describe('on disk', () => {
  test('the deleted rows are not left in the database or its write-ahead log', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bht-clear-'));
    const file = join(dir, 'bht.db');
    const { db, app } = server(file);
    expect(
      (db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete,
    ).toBe(1);
    const { phone, home } = await register(app, ORIGIN);
    const name = 'Quokka-Marmalade-7731';
    const note = 'ZEBRA-NOTE-4418-persimmon';
    const baby = { id: newId(), name, birthAt: '2026-10-25T10:00:00.000Z', sex: 'male' };
    await phone.json('/api/babies', baby);
    await phone.push([wet(baby.id, phone.deviceId, note), wet(home.baby.id, phone.deviceId, note)]);

    const bytes = () =>
      ['', '-wal'].map((s) => {
        try {
          return readFileSync(file + s, 'latin1');
        } catch {
          return '';
        }
      });
    expect(bytes().some((b) => b.includes(name))).toBe(true);
    expect(bytes().some((b) => b.includes(note))).toBe(true);

    await clearOk(phone);
    const after = bytes();
    expect(after.some((b) => b.includes(name))).toBe(false);
    expect(after.some((b) => b.includes(note))).toBe(false);
    expect(after.some((b) => b.includes(baby.id))).toBe(false);
    // The household and the member survive the clear.
    expect(after.some((b) => b.includes(home.householdId))).toBe(true);
    db.close();
  });
});
