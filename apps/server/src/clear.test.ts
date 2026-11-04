import {
  newId,
  type BabyEvent,
  type ClearResponse,
  type HouseholdView,
  type Invite,
  type PullResponse,
} from '@bht/schema';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { CLEARED } from './clear.ts';
import { openDatabase } from './db.ts';
import { Phone, register } from './testing/phone.ts';

// Clearing a household's data (#85): the server deletes it for good, and every sync request
// from a phone that has not seen the clear is refused whole.

const ORIGIN = 'https://bht.example.ts.net';
const RP_ID = 'bht.example.ts.net';
const T0 = Date.parse('2026-10-29T03:00:00.000Z');
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

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

const marker = (db: DatabaseSync, household: string) =>
  (db.prepare('SELECT clear_id, cleared_at FROM households WHERE id = ?').get(household) as {
    clear_id: string | null;
    cleared_at: string | null;
  }) ?? null;

async function clear(phone: Phone, clearId: string | null) {
  return phone.request('/api/household/clear', { clearId });
}

async function clearOk(phone: Phone, clearId: string | null) {
  return phone.json<ClearResponse>('/api/household/clear', { clearId });
}

/** A household with two babies, three versions of entries, and a watermark on its phone. */
async function filled(app: ReturnType<typeof server>['app']) {
  const { phone, home } = await register(app, ORIGIN);
  const second = { id: newId(), name: 'Wren', birthAt: '2026-10-25T10:00:00.000Z', sex: 'male' };
  await phone.json('/api/babies', second);
  const first = wet(home.baby.id, phone.deviceId);
  const edited = { ...first, version: 2, notes: 'edited' };
  const { serverNow } = await phone.push([first, edited, wet(second.id, phone.deviceId)]);
  await phone.json('/api/sync/barrier', { deviceId: phone.deviceId, gen: 3, at: serverNow });
  return { phone, home, second };
}

describe('POST /api/household/clear', () => {
  test('deletes the household’s babies and every version, old ones included; the other household is untouched', async () => {
    const { db, app, log } = server();
    const a = await filled(app);
    const b = await filled(app);
    expect(count(db, 'babies', a.home.householdId)).toBe(2);
    expect(count(db, 'event_versions', a.home.householdId)).toBe(3);

    const res = await clearOk(a.phone, null);
    expect(res.clearId).toMatch(ULID);
    expect(res.clearedAt).toBe(new Date(T0).toISOString());

    expect(count(db, 'babies', a.home.householdId)).toBe(0);
    expect(count(db, 'event_versions', a.home.householdId)).toBe(0);
    expect(marker(db, a.home.householdId)).toEqual({
      clear_id: res.clearId,
      cleared_at: res.clearedAt,
    });
    // The phone's watermark would vouch for windows of a log that no longer exists.
    const device = db
      .prepare('SELECT watermark, gen FROM devices WHERE id = ?')
      .get(a.phone.deviceId) as { watermark: number | null; gen: number | null };
    expect(device).toEqual({ watermark: null, gen: null });
    // The household, its member and its session stay: the phone is still signed in.
    const view = await a.phone.json<HouseholdView>('/api/household');
    expect(view.babies).toEqual([]);
    expect(view.members).toHaveLength(1);
    expect(view.clearId).toBe(res.clearId);

    // B lost nothing.
    expect(count(db, 'babies', b.home.householdId)).toBe(2);
    expect(count(db, 'event_versions', b.home.householdId)).toBe(3);
    expect(marker(db, b.home.householdId)).toEqual({ clear_id: null, cleared_at: null });

    // One log line with ids and counts, and no data.
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(`household ${a.home.householdId} cleared at ${res.clearedAt}`);
    expect(log[0]).toContain('2 babies and 3 event versions deleted');
    expect(log[0]).toContain(res.clearId);
    expect(log[0]).not.toContain('Wren');
  });

  test('compare-and-set: a phone that missed the last clear cannot clear what it has not seen', async () => {
    const { db, app } = server();
    const { phone, home } = await filled(app);
    const first = await clearOk(phone, null);
    // The next baby, logged under the new marker.
    const next = { id: newId(), name: 'Bo', birthAt: '2026-10-28T10:00:00.000Z', sex: 'female' };
    await phone.json('/api/babies', { ...next, clearId: first.clearId });
    await phone.push([wet(next.id, phone.deviceId)], first.clearId);

    for (const stale of [null, newId()]) {
      const res = await clear(phone, stale);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: CLEARED, cleared: first.clearId });
    }
    expect(count(db, 'babies', home.householdId)).toBe(1);
    expect(count(db, 'event_versions', home.householdId)).toBe(1);
    expect(marker(db, home.householdId).clear_id).toBe(first.clearId);

    // With the current marker it clears again, under a new one.
    const second = await clearOk(phone, first.clearId);
    expect(second.clearId).not.toBe(first.clearId);
    expect(count(db, 'babies', home.householdId)).toBe(0);
  });

  test('needs a session and a well-formed body', async () => {
    const { app } = server();
    expect((await clear(new Phone(app, ORIGIN), null)).status).toBe(401);
    const { phone } = await register(app, ORIGIN);
    expect((await phone.request('/api/household/clear', {})).status).toBe(400);
    expect((await phone.request('/api/household/clear', { clearId: 'x' })).status).toBe(400);
  });

  test('a fault partway leaves every row and no marker; the retry then clears', async () => {
    const { db, app } = server();
    const { phone, home } = await filled(app);
    // The last statement of the transaction fails, as a crash there would.
    db.exec(
      `CREATE TRIGGER fault BEFORE UPDATE OF clear_id ON households
       BEGIN SELECT RAISE(ABORT, 'disk gone'); END`,
    );
    app.onError((e, c) => c.json({ error: e.message }, 500));
    expect((await clear(phone, null)).status).toBe(500);
    expect(count(db, 'babies', home.householdId)).toBe(2);
    expect(count(db, 'event_versions', home.householdId)).toBe(3);
    expect(marker(db, home.householdId)).toEqual({ clear_id: null, cleared_at: null });
    // And the phone's push still works: nothing is half cleared.
    expect((await phone.push([wet(home.baby.id)])).results[0]).toMatchObject({
      status: 'accepted',
    });

    db.exec('DROP TRIGGER fault');
    await clearOk(phone, null);
    expect(count(db, 'event_versions', home.householdId)).toBe(0);
  });
});

describe('the marker check on every sync request', () => {
  test('after a clear, a missing or stale marker is refused whole, and nothing is written', async () => {
    const { db, app } = server();
    const { phone, home } = await filled(app);
    const { clearId } = await clearOk(phone, null);
    const baby = { id: newId(), name: 'Bo', birthAt: '2026-10-28T10:00:00.000Z', sex: 'female' };
    const refused = { error: CLEARED, cleared: clearId };

    for (const sent of [undefined, null, newId()]) {
      // Push: not even a valid entry for a baby the server has is stored.
      const push = await phone.request('/api/sync', {
        schemaVersion: 6,
        events: [wet(home.baby.id, phone.deviceId)],
        ...(sent !== undefined && { clearId: sent }),
      });
      expect(push.status).toBe(409);
      expect(await push.json()).toEqual(refused);
      // Babies: the cleared baby would otherwise come back on the phone's next reload.
      const add = await phone.request('/api/babies', {
        ...home.baby,
        ...(sent !== undefined && { clearId: sent }),
      });
      expect(add.status).toBe(409);
      expect(await add.json()).toEqual(refused);
      // Barrier: no watermark for a cleared log.
      const barrier = await phone.request('/api/sync/barrier', {
        deviceId: phone.deviceId,
        gen: 9,
        at: T0,
        ...(sent !== undefined && { clearId: sent }),
      });
      expect(barrier.status).toBe(409);
      expect(await barrier.json()).toEqual(refused);
    }
    // Pull: without the marker, or with another.
    for (const query of ['', `&clearId=${newId()}`]) {
      const pull = await phone.request(`/api/sync?after=0&limit=10${query}`);
      expect(pull.status).toBe(409);
      expect(await pull.json()).toEqual(refused);
    }
    expect(count(db, 'babies', home.householdId)).toBe(0);
    expect(count(db, 'event_versions', home.householdId)).toBe(0);
    expect(
      (
        db.prepare('SELECT watermark FROM devices WHERE id = ?').get(phone.deviceId) as {
          watermark: null;
        }
      ).watermark,
    ).toBeNull();

    // With the marker, everything works again, from a clean log.
    await phone.json('/api/babies', { ...baby, clearId });
    const entry = wet(baby.id, phone.deviceId);
    expect((await phone.push([entry], clearId)).results[0]).toMatchObject({ status: 'accepted' });
    const page = await phone.pull(clearId);
    expect(page.versions.map((v) => v.event)).toEqual([entry]);
    expect(page.clearId).toBe(clearId);
    expect(
      await phone.json('/api/sync/barrier', { deviceId: phone.deviceId, gen: 1, at: T0, clearId }),
    ).toMatchObject({ watermark: T0 });
  });

  test('before the first clear, an app from before #85 (no marker) keeps syncing', async () => {
    const { app } = server();
    const { phone, home } = await register(app, ORIGIN);
    const entry = wet(home.baby.id, phone.deviceId);
    expect((await phone.push([entry])).results[0]).toMatchObject({ status: 'accepted' });
    expect((await phone.push([entry], null)).results[0]).toMatchObject({ status: 'duplicate' });
    const page = await phone.pull();
    expect(page.versions.map((v) => v.event)).toEqual([entry]);
    // The first page carries the marker (null), so an updated app adopts it.
    expect(page.clearId).toBeNull();
    expect(await phone.json('/api/babies', { ...home.baby, id: newId() })).toMatchObject({
      householdId: home.householdId,
    });
  });

  test('a marker the household does not have is refused even before any clear: a restored database', async () => {
    // Undoing a first-ever clear restores clear_id = null. A phone that adopted the clear's
    // marker must not push over the restored log; it is refused and drops its copy instead.
    const { db, app } = server();
    const { phone, home } = await filled(app);
    const held = newId();
    const refused = { error: CLEARED, cleared: null };
    const push = await phone.request('/api/sync', {
      schemaVersion: 6,
      events: [wet(home.baby.id, phone.deviceId)],
      clearId: held,
    });
    expect(push.status).toBe(409);
    expect(await push.json()).toEqual(refused);
    const pull = await phone.request(`/api/sync?after=0&limit=10&clearId=${held}`);
    expect(pull.status).toBe(409);
    expect(await pull.json()).toEqual(refused);
    const barrier = await phone.request('/api/sync/barrier', {
      deviceId: phone.deviceId,
      gen: 9,
      at: T0,
      clearId: held,
    });
    expect(barrier.status).toBe(409);
    const add = await phone.request('/api/babies', { ...home.baby, id: newId(), clearId: held });
    expect(add.status).toBe(409);
    expect(count(db, 'event_versions', home.householdId)).toBe(3);
    expect(count(db, 'babies', home.householdId)).toBe(2);
  });

  test('a phone joining after a clear adopts the marker from /api/household and syncs', async () => {
    const { db, app } = server();
    const { phone: mom, home } = await filled(app);
    const { clearId } = await clearOk(mom, null);
    const invite = await mom.json<Invite>('/api/invites', {});

    const dad = new Phone(app, ORIGIN);
    const join = await dad.ceremony('join', {
      code: invite.code,
      displayName: 'Sam',
      deviceId: dad.deviceId,
    });
    expect((await join.verify()).status).toBe(200);
    const view = await dad.json<HouseholdView>('/api/household');
    expect(view).toMatchObject({ babies: [], clearId });

    // Dad's own baby and log, from before he joined, go up under the marker he adopted.
    const own = { id: newId(), name: 'Ada', birthAt: '2026-10-26T10:00:00.000Z', sex: 'female' };
    await dad.json('/api/babies', { ...own, clearId });
    const entry = wet(own.id, dad.deviceId);
    expect((await dad.push([entry], clearId)).results[0]).toMatchObject({ status: 'accepted' });
    expect((await mom.pull(clearId)).versions.map((v) => v.event)).toEqual([entry]);
    // Without it he is refused like anyone else.
    expect((await dad.request('/api/sync', { schemaVersion: 6, events: [] })).status).toBe(409);
    expect(count(db, 'babies', home.householdId)).toBe(1);
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

    await clearOk(phone, null);
    const after = bytes();
    expect(after.some((b) => b.includes(name))).toBe(false);
    expect(after.some((b) => b.includes(note))).toBe(false);
    expect(after.some((b) => b.includes(baby.id))).toBe(false);
    // The household and the member survive the clear.
    expect(after.some((b) => b.includes(home.householdId))).toBe(true);
    const page = await phone.pull(marker(db, home.householdId).clear_id!);
    expect(page).toMatchObject({ versions: [] } satisfies Partial<PullResponse>);
    db.close();
  });
});
