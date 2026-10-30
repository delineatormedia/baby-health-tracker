import {
  newId,
  SCHEMA_VERSION,
  type BabyEvent,
  type BarrierResponse,
  type PullResponse,
  type PushResponse,
} from '@bht/schema';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { ensureDevice, ensureHousehold, MIGRATIONS, openDatabase } from './db.ts';

// Write barriers and device watermarks (#5 step 3b, #17).

const A = newId();
const B = newId();
const babyA = newId();
const momPhone = newId();
const dadPhone = newId();
const otherPhone = newId();
const T0 = Date.parse('2026-10-29T12:00:00.000Z');

/** A server whose session is the phone in the x-test-device header; its clock is `clock.now`. */
function server() {
  const db = openDatabase(':memory:');
  ensureHousehold(db, A, [babyA]);
  ensureHousehold(db, B);
  ensureDevice(db, A, momPhone, 'Maya');
  ensureDevice(db, A, dadPhone, 'Sam');
  ensureDevice(db, B, otherPhone, 'Other');
  const homes: Record<string, string> = { [momPhone]: A, [dadPhone]: A, [otherPhone]: B };
  const clock = { now: T0 };
  const app = createApp(db, {
    session: (c) => {
      const deviceId = c.req.header('x-test-device');
      if (!deviceId || !homes[deviceId]) return null;
      return { householdId: homes[deviceId], memberId: `m-${deviceId}`, deviceId };
    },
    now: () => new Date(clock.now),
  });
  return { db, app, clock };
}

type App = ReturnType<typeof server>['app'];

function barrier(app: App, device: string, body: unknown) {
  return app.request('/api/sync/barrier', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-device': device },
    body: JSON.stringify(body),
  });
}

async function barrierOk(app: App, device: string, gen: number, at: number) {
  const res = await barrier(app, device, { deviceId: device, gen, at });
  expect(res.status).toBe(200);
  return (await res.json()) as BarrierResponse;
}

async function pull(app: App, device: string, after = 0, limit = 1000, through?: number) {
  const q = `after=${after}&limit=${limit}` + (through === undefined ? '' : `&through=${through}`);
  const res = await app.request(`/api/sync?${q}`, { headers: { 'x-test-device': device } });
  expect(res.status).toBe(200);
  return (await res.json()) as PullResponse;
}

async function push(app: App, device: string, events: BabyEvent[]) {
  const res = await app.request('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-device': device },
    body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, events }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PushResponse;
}

function wet(authorId: string): BabyEvent {
  const at = new Date(T0).toISOString();
  return {
    id: newId(),
    babyId: babyA,
    authorId,
    occurredAt: at,
    recordedAt: at,
    version: 1,
    deleted: false,
    notes: null,
    type: 'diaper',
    data: { kind: 'wet' },
  };
}

const watermarks = (page: PullResponse) =>
  Object.fromEntries((page.devices ?? []).map((d) => [d.memberName, d.watermark]));

describe('POST /api/sync/barrier', () => {
  test('sets the watermark, which the next pull’s first page reports', async () => {
    const { app } = server();
    expect(watermarks(await pull(app, momPhone))).toEqual({ Maya: null, Sam: null });
    expect(await barrierOk(app, dadPhone, 3, T0 - 5_000)).toEqual({
      watermark: T0 - 5_000,
      serverNow: T0,
    });
    const page = await pull(app, momPhone);
    expect(watermarks(page)).toEqual({ Maya: null, Sam: T0 - 5_000 });
    expect(page.devices!.find((d) => d.memberName === 'Sam')).toMatchObject({
      deviceId: dadPhone,
      lastSeenAt: T0,
      removedAt: null,
    });
  });

  test('`at` is clamped to the server’s clock', async () => {
    const { app } = server();
    expect((await barrierOk(app, dadPhone, 1, T0 + 3_600_000)).watermark).toBe(T0);
  });

  test('a late or replayed barrier with an older `at` leaves the watermark where it is', async () => {
    const { app, db } = server();
    await barrierOk(app, dadPhone, 5, T0 - 1_000);
    expect(await barrierOk(app, dadPhone, 2, T0 - 60_000)).toMatchObject({ watermark: T0 - 1_000 });
    expect(db.prepare('SELECT watermark, gen FROM devices WHERE id = ?').get(dadPhone)).toEqual({
      watermark: T0 - 1_000,
      gen: 5,
    });
  });

  test('a phone can only set its own watermark', async () => {
    const { app } = server();
    const res = await barrier(app, momPhone, { deviceId: dadPhone, gen: 1, at: T0 });
    expect(res.status).toBe(409);
    const elsewhere = await barrier(app, otherPhone, { deviceId: dadPhone, gen: 1, at: T0 });
    expect(elsewhere.status).toBe(409);
    expect(watermarks(await pull(app, momPhone))).toEqual({ Maya: null, Sam: null });
  });

  test('a removed phone’s barrier is refused', async () => {
    const { app, db } = server();
    db.prepare('UPDATE devices SET removed_at = ? WHERE id = ?').run(
      new Date(T0).toISOString(),
      dadPhone,
    );
    expect((await barrier(app, dadPhone, { deviceId: dadPhone, gen: 1, at: T0 })).status).toBe(401);
    const page = await pull(app, momPhone);
    expect(page.devices!.find((d) => d.deviceId === dadPhone)).toMatchObject({
      watermark: null,
      removedAt: T0,
    });
  });

  test('refuses a malformed body and a signed-out caller', async () => {
    const { app } = server();
    for (const body of [
      {},
      { deviceId: dadPhone, gen: -1, at: T0 },
      { deviceId: dadPhone, gen: 1 },
    ]) {
      expect((await barrier(app, dadPhone, body)).status).toBe(400);
    }
    const res = await app.request('/api/sync/barrier', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: dadPhone, gen: 1, at: T0 }),
    });
    expect(res.status).toBe(401);
  });

  test('lists only the caller’s household', async () => {
    const { app } = server();
    const page = await pull(app, otherPhone);
    expect(page.devices!.map((d) => d.deviceId)).toEqual([otherPhone]);
  });
});

describe('serverNow and the device list on a pull', () => {
  test('every push and page carries serverNow; only the first page carries devices', async () => {
    const { app, clock } = server();
    const events = [wet(dadPhone), wet(dadPhone), wet(dadPhone)];
    expect((await push(app, dadPhone, events)).serverNow).toBe(T0);
    clock.now = T0 + 1_000;
    const one = await pull(app, momPhone, 0, 1);
    expect(one).toMatchObject({ serverNow: T0 + 1_000, more: true });
    expect(one.devices).toHaveLength(2);
    clock.now = T0 + 2_000;
    const two = await pull(app, momPhone, one.next, 1, one.through);
    expect(two.serverNow).toBe(T0 + 2_000);
    expect(two.devices).toBeUndefined();
  });

  test('a push and barrier between pages are not in the first page’s list', async () => {
    const { app, clock } = server();
    await push(app, dadPhone, [wet(dadPhone), wet(dadPhone)]);
    const one = await pull(app, momPhone, 0, 1);
    // Dad pushes again and sends a barrier for it while mom is between pages.
    clock.now = T0 + 10_000;
    await push(app, dadPhone, [wet(dadPhone)]);
    await barrierOk(app, dadPhone, 3, T0 + 10_000);
    const two = await pull(app, momPhone, one.next, 1, one.through);
    expect(two.more).toBe(false);
    expect(two.versions).toHaveLength(1);
    // The list mom adopts with the page at through says nothing about the third entry.
    expect(watermarks(one)).toEqual({ Maya: null, Sam: null });
    // The next pull sees both the entry and the watermark covering it.
    const next = await pull(app, momPhone, two.next);
    expect(next.versions).toHaveLength(1);
    expect(watermarks(next)).toEqual({ Maya: null, Sam: T0 + 10_000 });
  });
});

describe('migration 3', () => {
  test('a step 2 database upgrades with every watermark null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bht-'));
    try {
      const path = join(dir, 'bht.db');
      const old = new DatabaseSync(path);
      old.exec(MIGRATIONS[0]!);
      old.exec(MIGRATIONS[1]!);
      old.exec('PRAGMA user_version = 2');
      old.close();
      const db = openDatabase(path);
      ensureHousehold(db, A, [babyA]);
      ensureDevice(db, A, dadPhone, 'Sam');
      expect(db.prepare('SELECT watermark, gen FROM devices').all()).toEqual([
        { watermark: null, gen: null },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
