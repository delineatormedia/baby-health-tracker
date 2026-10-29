import {
  newId,
  SCHEMA_VERSION,
  type BabyEvent,
  type CeremonyOptions,
  type HouseholdView,
  type Invite,
  type PullResponse,
  type PushResponse,
} from '@bht/schema';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { SoftAuthenticator } from './testing/authenticator.ts';

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

type App = ReturnType<typeof server>['app'];

/** A phone: its passkey authenticator, its local ids, and the session cookie it holds. */
class Phone {
  readonly passkeys = new SoftAuthenticator(ORIGIN);
  readonly deviceId = newId();
  cookie: string | null = null;
  setCookie: string | null = null;

  constructor(readonly app: App) {}

  async request(path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      this.setCookie = set;
      const pair = set.split(';')[0]!;
      this.cookie = pair.endsWith('=') ? null : pair;
    }
    return res;
  }

  async json<T>(path: string, body?: unknown, status = 200): Promise<T> {
    const res = await this.request(path, body);
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(status);
    return (await res.json()) as T;
  }

  /** Options, then the authenticator, then verify: one passkey ceremony. */
  async ceremony(kind: 'register' | 'join' | 'login', request: unknown) {
    const { flowId, options } = await this.json<CeremonyOptions>(
      `/api/auth/${kind}/options`,
      request,
    );
    const response =
      kind === 'login'
        ? this.passkeys.get(options as unknown as PublicKeyCredentialRequestOptionsJSON)
        : this.passkeys.create(options as unknown as PublicKeyCredentialCreationOptionsJSON);
    return {
      flowId,
      response,
      verify: () => this.request(`/api/auth/${kind}/verify`, { flowId, response }),
    };
  }

  push(events: unknown[]) {
    return this.json<PushResponse>('/api/sync', { schemaVersion: SCHEMA_VERSION, events });
  }

  pull() {
    return this.json<PullResponse>('/api/sync?after=0&limit=1000');
  }
}

function newHousehold() {
  return {
    householdId: newId(),
    displayName: 'Maya',
    baby: { id: newId(), name: 'Pip', birthAt: '2026-10-20T08:15:00.000Z', sex: 'female' as const },
  };
}

async function register(app: App) {
  const phone = new Phone(app);
  const home = newHousehold();
  const { verify } = await phone.ceremony('register', { ...home, deviceId: phone.deviceId });
  const res = await verify();
  expect(res.status).toBe(200);
  return { phone, home, signedIn: (await res.json()) as { householdId: string; memberId: string } };
}

function wet(babyId: string, authorId = newId()): BabyEvent {
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

describe('registration', () => {
  test('the first member creates the household from the phone’s own ids, signed in', async () => {
    const { app, db } = server();
    const { phone, home, signedIn } = await register(app);
    expect(signedIn.householdId).toBe(home.householdId);
    expect(phone.setCookie).toMatch(/^bht_session=[\w-]{43};/);
    expect(phone.setCookie).toMatch(/HttpOnly/);
    expect(phone.setCookie).toMatch(/Secure/);
    expect(phone.setCookie).toMatch(/SameSite=Strict/);
    const view = await phone.json<HouseholdView>('/api/household');
    expect(view).toEqual({
      id: home.householdId,
      members: [{ id: signedIn.memberId, displayName: 'Maya' }],
      babies: [{ ...home.baby, householdId: home.householdId }],
    });
    // Entries logged before sign-in keep their babyId and go up as they are.
    const before = wet(home.baby.id, phone.deviceId);
    const [result] = (await phone.push([before])).results;
    expect(result).toMatchObject({ status: 'accepted' });
    // The server records who pushed, from the session, not from authorId.
    expect(db.prepare('SELECT member_id FROM event_versions').all()).toEqual([
      { member_id: signedIn.memberId },
    ]);
    expect(db.prepare('SELECT id, member_id FROM devices').all()).toEqual([
      { id: phone.deviceId, member_id: signedIn.memberId },
    ]);
    // Only hashes are stored.
    const token = phone.cookie!.split('=')[1]!;
    const stored = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).not.toContain(token);
  });

  test('a push for a baby outside the household is refused', async () => {
    const { app } = server();
    const { phone } = await register(app);
    const [result] = (await phone.push([wet(newId())])).results;
    expect(result).toMatchObject({ status: 'rejected', error: 'Unknown baby' });
  });

  test('a household or baby id that exists is refused, before and after the ceremony', async () => {
    const { app } = server();
    const { home } = await register(app);
    const other = new Phone(app);
    const res = await other.request('/api/auth/register/options', {
      ...home,
      deviceId: other.deviceId,
    });
    expect(res.status).toBe(409);
    const sameBaby = { ...newHousehold(), baby: home.baby };
    expect(
      (await other.request('/api/auth/register/options', { ...sameBaby, deviceId: other.deviceId }))
        .status,
    ).toBe(409);
    // Two phones racing on one id: both get options, only the first verify creates it.
    const race = newHousehold();
    const one = await new Phone(app).ceremony('register', { ...race, deviceId: newId() });
    const two = await new Phone(app).ceremony('register', { ...race, deviceId: newId() });
    expect((await one.verify()).status).toBe(200);
    expect((await two.verify()).status).toBe(409);
  });

  test('a flow is single-use, expires, and checks origin and challenge', async () => {
    const { app, clock } = server();
    const phone = new Phone(app);
    const first = await phone.ceremony('register', { ...newHousehold(), deviceId: phone.deviceId });
    expect((await first.verify()).status).toBe(200);
    // Replaying the same verify.
    expect((await first.verify()).status).toBe(401);

    const late = await new Phone(app).ceremony('register', {
      ...newHousehold(),
      deviceId: newId(),
    });
    clock.t += 6 * 60_000;
    expect((await late.verify()).status).toBe(401);

    const elsewhere = new Phone(app);
    Object.defineProperty(elsewhere.passkeys, 'origin', { value: 'https://evil.example' });
    const wrongOrigin = await elsewhere.ceremony('register', {
      ...newHousehold(),
      deviceId: newId(),
    });
    expect((await wrongOrigin.verify()).status).toBe(401);

    // An answer to another flow's challenge.
    const a = await new Phone(app).ceremony('register', { ...newHousehold(), deviceId: newId() });
    const b = await new Phone(app).ceremony('register', { ...newHousehold(), deviceId: newId() });
    const swapped = await app.request('/api/auth/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId: a.flowId, response: b.response }),
    });
    expect(swapped.status).toBe(401);
  });

  test('malformed requests get 400', async () => {
    const { app } = server();
    const phone = new Phone(app);
    expect((await phone.request('/api/auth/register/options', { displayName: 'x' })).status).toBe(
      400,
    );
    expect((await phone.request('/api/auth/register/verify', { flowId: 1 })).status).toBe(400);
    expect((await phone.request('/api/auth/join/options', { code: 'nope' })).status).toBe(400);
  });
});

describe('invites', () => {
  test('a second phone joins by invite, gets the household’s baby, and both sync', async () => {
    const { app } = server();
    const { phone: mom, home } = await register(app);
    const invite = await mom.json<Invite>('/api/invites', {});
    expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(invite.expiresAt).toBe('2026-10-30T03:00:00.000Z');

    const dad = new Phone(app);
    const join = await dad.ceremony('join', {
      code: invite.code,
      displayName: 'Sam',
      deviceId: dad.deviceId,
    });
    const res = await join.verify();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ householdId: home.householdId });
    const view = await dad.json<HouseholdView>('/api/household');
    expect(view.members.map((m) => m.displayName)).toEqual(['Maya', 'Sam']);
    expect(view.babies.map((b) => b.id)).toEqual([home.baby.id]);

    const fromDad = wet(home.baby.id, dad.deviceId);
    await dad.push([fromDad]);
    expect((await mom.pull()).versions.map((v) => v.event)).toEqual([fromDad]);
  });

  test('an invite works once', async () => {
    const { app } = server();
    const { phone: mom } = await register(app);
    const { code } = await mom.json<Invite>('/api/invites', {});
    // Two phones start with the same code; the first to finish uses it up.
    const one = await new Phone(app).ceremony('join', {
      code,
      displayName: 'Sam',
      deviceId: newId(),
    });
    const two = await new Phone(app).ceremony('join', {
      code,
      displayName: 'Eve',
      deviceId: newId(),
    });
    expect((await one.verify()).status).toBe(200);
    expect((await two.verify()).status).toBe(404);
    // Nothing of the second join was kept.
    const view = await mom.json<HouseholdView>('/api/household');
    expect(view.members.map((m) => m.displayName)).toEqual(['Maya', 'Sam']);
    const third = new Phone(app);
    expect(
      (
        await third.request('/api/auth/join/options', {
          code,
          displayName: 'Eve',
          deviceId: third.deviceId,
        })
      ).status,
    ).toBe(404);
  });

  test('an invite expires after 24 hours', async () => {
    const { app, clock } = server();
    const { phone: mom } = await register(app);
    const { code } = await mom.json<Invite>('/api/invites', {});
    clock.t += 24 * 3_600_000;
    const dad = new Phone(app);
    const res = await dad.request('/api/auth/join/options', {
      code,
      displayName: 'Sam',
      deviceId: dad.deviceId,
    });
    expect(res.status).toBe(404);
  });

  test('an unknown code and a signed-out invite request are refused', async () => {
    const { app } = server();
    const phone = new Phone(app);
    const res = await phone.request('/api/auth/join/options', {
      code: 'ABCDEFGHJK',
      displayName: 'Sam',
      deviceId: phone.deviceId,
    });
    expect(res.status).toBe(404);
    expect((await phone.request('/api/invites', {})).status).toBe(401);
  });
});

describe('sessions', () => {
  test('sign out ends the session; signing in with the passkey starts a new one', async () => {
    const { app, db } = server();
    const { phone, signedIn } = await register(app);
    const old = phone.cookie!;
    await phone.json('/api/auth/logout', {});
    expect(phone.cookie).toBeNull();
    // The old token is dead even if a copy was kept.
    phone.cookie = old;
    expect((await phone.request('/api/sync')).status).toBe(401);
    phone.cookie = null;

    const login = await phone.ceremony('login', { deviceId: phone.deviceId });
    const res = await login.verify();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(signedIn);
    expect((await phone.request('/api/sync')).status).toBe(200);
    expect(db.prepare('SELECT counter FROM credentials').get()).toEqual({ counter: 1 });
  });

  test('a passkey this server does not hold, or a forged signature, does not sign in', async () => {
    const { app } = server();
    const { phone } = await register(app);
    const stranger = new Phone(app);
    // The stranger has a passkey, but for a ceremony this server never finished.
    const { options } = await stranger.json<CeremonyOptions>('/api/auth/register/options', {
      ...newHousehold(),
      deviceId: stranger.deviceId,
    });
    stranger.passkeys.create(options as unknown as PublicKeyCredentialCreationOptionsJSON);
    expect(
      (await (await stranger.ceremony('login', { deviceId: stranger.deviceId })).verify()).status,
    ).toBe(401);

    const login = await phone.ceremony('login', { deviceId: phone.deviceId });
    const forged = structuredClone(login.response) as { response: { signature: string } };
    const sig = Buffer.from(forged.response.signature, 'base64url');
    sig[sig.length - 1]! ^= 1;
    forged.response.signature = sig.toString('base64url');
    const res = await phone.request('/api/auth/login/verify', {
      flowId: login.flowId,
      response: forged,
    });
    expect(res.status).toBe(401);
  });

  test('a session expires after 180 days', async () => {
    const { app, clock } = server();
    const { phone } = await register(app);
    clock.t += 180 * 86_400_000;
    expect((await phone.request('/api/sync')).status).toBe(401);
  });

  test('a removed phone’s session no longer works', async () => {
    const { app, db } = server();
    const { phone } = await register(app);
    db.prepare('UPDATE devices SET removed_at = ?').run('2026-10-29T04:00:00.000Z');
    expect((await phone.request('/api/sync')).status).toBe(401);
    // Nor can it sign itself back in.
    const login = await phone.ceremony('login', { deviceId: phone.deviceId });
    expect((await login.verify()).status).toBe(401);
    expect(db.prepare('SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL').get()).toEqual(
      {
        n: 1,
      },
    );
  });
});

describe('household isolation through real sessions', () => {
  test('A cannot read B, write into B’s events, or log for B’s baby', async () => {
    const { app } = server();
    const a = await register(app);
    const b = await register(app);
    const bEvent = wet(b.home.baby.id);
    await b.phone.push([bEvent]);
    const aEvent = wet(a.home.baby.id);
    await a.phone.push([aEvent]);
    expect((await a.phone.pull()).versions.map((v) => v.event.id)).toEqual([aEvent.id]);
    expect((await b.phone.pull()).versions.map((v) => v.event.id)).toEqual([bEvent.id]);
    const [intoB] = (await a.phone.push([{ ...bEvent, version: 2, deleted: true }])).results;
    expect(intoB).toMatchObject({ status: 'rejected', error: 'Unknown event' });
    const [forB] = (await a.phone.push([wet(b.home.baby.id)])).results;
    expect(forB).toMatchObject({ status: 'rejected', error: 'Unknown baby' });
    const view = await a.phone.json<HouseholdView>('/api/household');
    expect(view.id).toBe(a.home.householdId);
    expect(view.babies.map((x) => x.id)).toEqual([a.home.baby.id]);
  });
});

describe('without auth configured', () => {
  test('sign-in answers 503 and sync stays closed', async () => {
    const app = createApp(openDatabase(':memory:'));
    const res = await app.request('/api/auth/login/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: newId() }),
    });
    expect(res.status).toBe(503);
    expect((await app.request('/api/sync')).status).toBe(401);
    expect((await app.request('/api/household')).status).toBe(401);
  });
});
