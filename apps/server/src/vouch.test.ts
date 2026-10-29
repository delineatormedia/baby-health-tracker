import { newId, type BabyEvent, type HouseholdDevice, type Invite } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { Phone, register } from './testing/phone.ts';

// Signed-out and removed phones (#5 step 3b): when the household stops waiting for a phone.

const ORIGIN = 'https://bht.example.ts.net';
const RP_ID = 'bht.example.ts.net';
const T0 = Date.parse('2026-10-29T03:00:00.000Z');

function server() {
  const db = openDatabase(':memory:');
  const clock = { t: T0 };
  const app = createApp(db, {
    auth: { rpId: RP_ID, origin: ORIGIN },
    now: () => new Date(clock.t),
  });
  return { db, app, clock };
}

/** Maya's phone and Sam's phone in one household. */
async function household() {
  const s = server();
  const { phone: mom, home } = await register(s.app, ORIGIN);
  const invite = await mom.json<Invite>('/api/invites', {});
  const dad = new Phone(s.app, ORIGIN);
  const join = await dad.ceremony('join', {
    code: invite.code,
    displayName: 'Sam',
    deviceId: dad.deviceId,
  });
  expect((await join.verify()).status).toBe(200);
  return { ...s, mom, dad, home };
}

function wet(babyId: string, authorId: string): BabyEvent {
  return {
    id: newId(),
    babyId,
    authorId,
    occurredAt: '2026-10-29T02:00:00.000Z',
    recordedAt: '2026-10-29T02:00:00.000Z',
    version: 1,
    deleted: false,
    notes: null,
    type: 'diaper',
    data: { kind: 'wet' },
  };
}

async function devices(phone: Phone): Promise<HouseholdDevice[]> {
  const page = await phone.pull();
  return page.devices!;
}

const find = (list: HouseholdDevice[], id: string) => list.find((d) => d.deviceId === id)!;

describe('signing out', () => {
  test('a logout with the gen of a stored barrier marks the phone signed out', async () => {
    const { mom, dad, clock } = await household();
    await dad.json('/api/sync/barrier', { deviceId: dad.deviceId, gen: 4, at: T0 });
    clock.t += 1_000;
    await dad.json('/api/auth/logout', { gen: 4 });
    expect(find(await devices(mom), dad.deviceId)).toMatchObject({
      watermark: T0,
      signedOutAt: T0 + 1_000,
    });
  });

  test('without a matching barrier the session ends but the household keeps waiting', async () => {
    const { mom, dad } = await household();
    await dad.json('/api/sync/barrier', { deviceId: dad.deviceId, gen: 4, at: T0 });
    // A write after the last barrier: the claimed gen is past what the server holds.
    await dad.json('/api/auth/logout', { gen: 5 });
    expect(dad.cookie).toBeNull();
    expect(find(await devices(mom), dad.deviceId).signedOutAt).toBeNull();
  });

  test('an offline-style logout (no gen) or no barrier at all never marks it', async () => {
    const one = await household();
    await one.dad.json('/api/sync/barrier', { deviceId: one.dad.deviceId, gen: 4, at: T0 });
    await one.dad.json('/api/auth/logout', {});
    expect(find(await devices(one.mom), one.dad.deviceId).signedOutAt).toBeNull();

    const two = await household();
    await two.dad.json('/api/auth/logout', { gen: 0 });
    expect(find(await devices(two.mom), two.dad.deviceId).signedOutAt).toBeNull();
  });

  test('a malformed body still signs out, unmarked', async () => {
    const { mom, dad } = await household();
    await dad.json('/api/sync/barrier', { deviceId: dad.deviceId, gen: 4, at: T0 });
    await dad.json('/api/auth/logout', { gen: 'all' });
    expect(dad.cookie).toBeNull();
    expect(find(await devices(mom), dad.deviceId).signedOutAt).toBeNull();
  });

  test('signing back in on the same phone clears the mark', async () => {
    const { mom, dad } = await household();
    await dad.json('/api/sync/barrier', { deviceId: dad.deviceId, gen: 1, at: T0 });
    await dad.json('/api/auth/logout', { gen: 1 });
    expect(find(await devices(mom), dad.deviceId).signedOutAt).not.toBeNull();
    const login = await dad.ceremony('login', { deviceId: dad.deviceId });
    expect((await login.verify()).status).toBe(200);
    expect(find(await devices(mom), dad.deviceId).signedOutAt).toBeNull();
  });
});

describe('removing a phone', () => {
  test('ends its sessions, refuses its push and sign-in, and lists removedAt', async () => {
    const { mom, dad, home, clock } = await household();
    clock.t += 5_000;
    const body = await mom.json<{ removedAt: number }>('/api/devices/remove', {
      deviceId: dad.deviceId,
    });
    expect(body).toEqual({ removedAt: T0 + 5_000 });
    expect(find(await devices(mom), dad.deviceId).removedAt).toBe(T0 + 5_000);
    // Its session is refused on push, and it cannot sign back in under that id.
    const res = await dad.request('/api/sync', { schemaVersion: 5, events: [] });
    expect(res.status).toBe(401);
    expect(
      (
        await dad.request('/api/sync', {
          schemaVersion: 5,
          events: [wet(home.baby.id, dad.deviceId)],
        })
      ).status,
    ).toBe(401);
    const login = await dad.ceremony('login', { deviceId: dad.deviceId });
    expect((await login.verify()).status).toBe(401);
  });

  test('a second removal keeps the first time', async () => {
    const { mom, dad, clock } = await household();
    await mom.json('/api/devices/remove', { deviceId: dad.deviceId });
    clock.t += 60_000;
    expect(await mom.json('/api/devices/remove', { deviceId: dad.deviceId })).toEqual({
      removedAt: T0,
    });
  });

  test('a phone cannot remove itself, or a phone of another household', async () => {
    const { app, mom, dad } = await household();
    await mom.json('/api/devices/remove', { deviceId: mom.deviceId }, 409);
    const { phone: stranger } = await register(app, ORIGIN);
    await stranger.json('/api/devices/remove', { deviceId: dad.deviceId }, 404);
    await mom.json('/api/devices/remove', { deviceId: 'phone' }, 400);
    expect(find(await devices(mom), dad.deviceId).removedAt).toBeNull();
  });

  test('needs a session', async () => {
    const { app, dad } = await household();
    const anon = new Phone(app, ORIGIN);
    expect((await anon.request('/api/devices/remove', { deviceId: dad.deviceId })).status).toBe(
      401,
    );
  });
});
