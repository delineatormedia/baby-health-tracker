import {
  newId,
  type BabyEvent,
  type CeremonyOptions,
  type HouseholdView,
  type Invite,
} from '@bht/schema';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { describe, expect, test } from 'vitest';
import { DEVICE_ELSEWHERE, FLOW_COOKIE, hashSecret, REGISTRATION_CLOSED } from './auth.ts';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { newHousehold, Phone, register } from './testing/phone.ts';

const ORIGIN = 'https://bht.example.ts.net';
const RP_ID = 'bht.example.ts.net';
const T0 = Date.parse('2026-10-29T03:00:00.000Z');

function server(registration: 'open' | 'first' = 'open') {
  const db = openDatabase(':memory:');
  const clock = { t: T0 };
  const app = createApp(db, {
    auth: { rpId: RP_ID, origin: ORIGIN, registration },
    now: () => new Date(clock.t),
  });
  return { db, app, clock };
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
    const { phone, home, signedIn } = await register(app, ORIGIN);
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
    const { phone } = await register(app, ORIGIN);
    const [result] = (await phone.push([wet(newId())])).results;
    expect(result).toMatchObject({ status: 'rejected', error: 'Unknown baby' });
  });

  test('a household or baby id that exists is refused, before and after the ceremony', async () => {
    const { app } = server();
    const { home } = await register(app, ORIGIN);
    const other = new Phone(app, ORIGIN);
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
    const one = await new Phone(app, ORIGIN).ceremony('register', { ...race, deviceId: newId() });
    const two = await new Phone(app, ORIGIN).ceremony('register', { ...race, deviceId: newId() });
    expect((await one.verify()).status).toBe(200);
    expect((await two.verify()).status).toBe(409);
  });

  test('a flow is single-use, expires, and checks origin and challenge', async () => {
    const { app, clock } = server();
    const phone = new Phone(app, ORIGIN);
    const first = await phone.ceremony('register', { ...newHousehold(), deviceId: phone.deviceId });
    expect((await first.verify()).status).toBe(200);
    // Replaying the same verify.
    expect((await first.verify()).status).toBe(401);

    const late = await new Phone(app, ORIGIN).ceremony('register', {
      ...newHousehold(),
      deviceId: newId(),
    });
    clock.t += 6 * 60_000;
    expect((await late.verify()).status).toBe(401);

    const elsewhere = new Phone(app, ORIGIN);
    Object.defineProperty(elsewhere.passkeys, 'origin', { value: 'https://evil.example' });
    const wrongOrigin = await elsewhere.ceremony('register', {
      ...newHousehold(),
      deviceId: newId(),
    });
    expect((await wrongOrigin.verify()).status).toBe(401);

    // An answer to another flow's challenge, from the browser that started the first flow.
    const aPhone = new Phone(app, ORIGIN);
    const a = await aPhone.ceremony('register', { ...newHousehold(), deviceId: newId() });
    const b = await new Phone(app, ORIGIN).ceremony('register', {
      ...newHousehold(),
      deviceId: newId(),
    });
    const swapped = await aPhone.request('/api/auth/register/verify', {
      flowId: a.flowId,
      response: b.response,
    });
    expect(swapped.status).toBe(401);
  });

  test('malformed requests get 400', async () => {
    const { app } = server();
    const phone = new Phone(app, ORIGIN);
    expect((await phone.request('/api/auth/register/options', { displayName: 'x' })).status).toBe(
      400,
    );
    expect((await phone.request('/api/auth/register/verify', { flowId: 1 })).status).toBe(400);
    expect((await phone.request('/api/auth/join/options', { code: 'nope' })).status).toBe(400);
  });
});

describe('registration: first household only (BHT_REGISTRATION=first)', () => {
  const households = (db: ReturnType<typeof server>['db']) =>
    db.prepare('SELECT COUNT(*) AS n FROM households').get() as { n: number };

  test('the first registers; a second is refused at options, and joins by invite', async () => {
    const { app, db } = server('first');
    const { phone: mom, home } = await register(app, ORIGIN);
    const other = new Phone(app, ORIGIN);
    const res = await other.request('/api/auth/register/options', {
      ...newHousehold(),
      deviceId: other.deviceId,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: REGISTRATION_CLOSED });
    expect(households(db)).toEqual({ n: 1 });
    // An invite still brings a second parent in.
    const { code } = await mom.json<Invite>('/api/invites', {});
    const join = await other.ceremony('join', {
      code,
      displayName: 'Sam',
      deviceId: other.deviceId,
    });
    expect((await join.verify()).status).toBe(200);
    const view = await other.json<HouseholdView>('/api/household');
    expect(view.id).toBe(home.householdId);
  });

  test('two phones racing to be first: only one household is created', async () => {
    const { app, db } = server('first');
    const a = new Phone(app, ORIGIN);
    const b = new Phone(app, ORIGIN);
    // Both get options while the server is still empty.
    const one = await a.ceremony('register', { ...newHousehold(), deviceId: a.deviceId });
    const two = await b.ceremony('register', { ...newHousehold(), deviceId: b.deviceId });
    expect((await one.verify()).status).toBe(200);
    const late = await two.verify();
    expect(late.status).toBe(403);
    expect(await late.json()).toEqual({ error: REGISTRATION_CLOSED });
    expect(households(db)).toEqual({ n: 1 });
  });

  test('open, the default, still lets a second household register', async () => {
    const { app, db } = server();
    await register(app, ORIGIN);
    await register(app, ORIGIN);
    expect(households(db)).toEqual({ n: 2 });
  });
});

describe('invites', () => {
  test('a second phone joins by invite, gets the household’s baby, and both sync', async () => {
    const { app } = server();
    const { phone: mom, home } = await register(app, ORIGIN);
    const invite = await mom.json<Invite>('/api/invites', {});
    expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(invite.expiresAt).toBe('2026-10-30T03:00:00.000Z');

    const dad = new Phone(app, ORIGIN);
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
    const { phone: mom } = await register(app, ORIGIN);
    const { code } = await mom.json<Invite>('/api/invites', {});
    // Two phones start with the same code; the first to finish uses it up.
    const one = await new Phone(app, ORIGIN).ceremony('join', {
      code,
      displayName: 'Sam',
      deviceId: newId(),
    });
    const two = await new Phone(app, ORIGIN).ceremony('join', {
      code,
      displayName: 'Eve',
      deviceId: newId(),
    });
    expect((await one.verify()).status).toBe(200);
    expect((await two.verify()).status).toBe(404);
    // Nothing of the second join was kept.
    const view = await mom.json<HouseholdView>('/api/household');
    expect(view.members.map((m) => m.displayName)).toEqual(['Maya', 'Sam']);
    const third = new Phone(app, ORIGIN);
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
    const { phone: mom } = await register(app, ORIGIN);
    const { code } = await mom.json<Invite>('/api/invites', {});
    clock.t += 24 * 3_600_000;
    const dad = new Phone(app, ORIGIN);
    const res = await dad.request('/api/auth/join/options', {
      code,
      displayName: 'Sam',
      deviceId: dad.deviceId,
    });
    expect(res.status).toBe(404);
  });

  test('an unknown code and a signed-out invite request are refused', async () => {
    const { app } = server();
    const phone = new Phone(app, ORIGIN);
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
    const { phone, signedIn } = await register(app, ORIGIN);
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
    const { phone } = await register(app, ORIGIN);
    const stranger = new Phone(app, ORIGIN);
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
    const { phone } = await register(app, ORIGIN);
    clock.t += 180 * 86_400_000;
    expect((await phone.request('/api/sync')).status).toBe(401);
  });

  test('a removed phone’s session no longer works', async () => {
    const { app, db } = server();
    const { phone } = await register(app, ORIGIN);
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

describe('babies', () => {
  test('a baby added after sign-up takes pushes; a retry is safe; another household is refused', async () => {
    const { app } = server();
    const a = await register(app, ORIGIN);
    const b = await register(app, ORIGIN);
    const second = {
      id: newId(),
      name: 'Wren',
      birthAt: '2027-12-01T10:00:00.000Z',
      sex: 'unspecified',
    };
    const entry = wet(second.id, a.phone.deviceId);
    // Before it is added, its entries are refused.
    expect((await a.phone.push([entry])).results[0]).toMatchObject({ error: 'Unknown baby' });
    const added = await a.phone.json('/api/babies', second);
    expect(added).toEqual({ ...second, householdId: a.home.householdId });
    expect(await a.phone.json('/api/babies', second)).toEqual(added);
    expect((await a.phone.push([entry])).results[0]).toMatchObject({ status: 'accepted' });
    const view = await a.phone.json<HouseholdView>('/api/household');
    expect(view.babies.map((x) => x.id)).toEqual([a.home.baby.id, second.id]);
    // B cannot claim it, add a baby to A, or push for it.
    expect((await b.phone.request('/api/babies', second)).status).toBe(409);
    expect(
      (await b.phone.request('/api/babies', { ...b.home.baby, id: a.home.baby.id })).status,
    ).toBe(409);
    expect((await b.phone.push([wet(second.id)])).results[0]).toMatchObject({
      error: 'Unknown baby',
    });
    // Signed out, and malformed.
    expect((await new Phone(app, ORIGIN).request('/api/babies', second)).status).toBe(401);
    expect((await a.phone.request('/api/babies', { id: 'x' })).status).toBe(400);
  });
});

describe('household isolation through real sessions', () => {
  test('A cannot read B, write into B’s events, or log for B’s baby', async () => {
    const { app } = server();
    const a = await register(app, ORIGIN);
    const b = await register(app, ORIGIN);
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

describe('cross-site requests', () => {
  const WRITES = [
    '/api/auth/register/options',
    '/api/auth/login/verify',
    '/api/auth/logout',
    '/api/invites',
    '/api/babies',
    '/api/sync',
  ];

  test('a write from another origin, or with no Origin, is 403', async () => {
    const { app } = server();
    const { phone } = await register(app, ORIGIN);
    for (const path of WRITES) {
      for (const origin of ['https://evil.example', 'http://bht.example.ts.net', undefined]) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (origin) headers.origin = origin;
        if (phone.cookie) headers.cookie = phone.cookie;
        const res = await app.request(path, { method: 'POST', headers, body: '{}' });
        expect(res.status, `${path} from ${origin}`).toBe(403);
      }
    }
    // Still signed in: none of them reached a handler.
    expect((await phone.request('/api/household')).status).toBe(200);
  });

  test('a write that is not application/json is 415', async () => {
    const { app } = server();
    const { phone } = await register(app, ORIGIN);
    for (const path of WRITES) {
      for (const type of [
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
      ]) {
        const post = await app.request(path, {
          method: 'POST',
          headers: { 'content-type': type, origin: ORIGIN, cookie: phone.cookie! },
          body: '{}',
        });
        expect(post.status, `${path} as ${type}`).toBe(415);
      }
      const none = await app.request(path, {
        method: 'POST',
        headers: { origin: ORIGIN },
        body: '{}',
      });
      expect(none.status, `${path} without a type`).toBe(415);
    }
    // A charset parameter is still JSON.
    const res = await app.request('/api/invites', {
      method: 'POST',
      headers: {
        'content-type': 'Application/JSON; charset=utf-8',
        origin: ORIGIN,
        cookie: phone.cookie!,
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  test('the review’s cross-site text/plain form does not sign in', async () => {
    const { app } = server();
    const attacker = await register(app, ORIGIN);
    const login = await attacker.phone.ceremony('login', { deviceId: newId() });
    // padding absorbs the form's name=value separator inside the JSON.
    const body = JSON.stringify({
      flowId: login.flowId,
      response: { ...login.response, padding: '=' },
    });
    const res = await app.request('/api/auth/login/verify', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
      },
      body: body + '\r\n',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('verify needs the flow cookie of the browser that asked for options', async () => {
    const { app } = server();
    const attacker = await register(app, ORIGIN);
    const login = await attacker.phone.ceremony('login', { deviceId: attacker.phone.deviceId });
    const victim = new Phone(app, ORIGIN);
    // Right origin and content type, but no flow cookie: the assertion is replayed elsewhere.
    const bare = await victim.request('/api/auth/login/verify', {
      flowId: login.flowId,
      response: login.response,
    });
    expect(bare.status).toBe(403);
    expect(victim.cookie).toBeNull();
    // A flow cookie from the victim's own sign-in does not match the attacker's flow either.
    await victim.json('/api/auth/login/options', { deviceId: victim.deviceId });
    expect(victim.flow).not.toBeNull();
    const crossed = await victim.request('/api/auth/login/verify', {
      flowId: login.flowId,
      response: login.response,
    });
    expect(crossed.status).toBe(403);
    expect(victim.cookie).toBeNull();
    // Neither attempt used the flow up: its own browser still finishes it, and the flow
    // cookie is cleared with the session cookie set.
    const res = await login.verify();
    expect(res.status).toBe(200);
    expect(attacker.phone.flow).toBeNull();
    expect(res.headers.getSetCookie().find((c) => c.startsWith(`${FLOW_COOKIE}=`))).toMatch(
      /Path=\/api\/auth/,
    );
  });

  test('the flow cookie is HttpOnly, Secure, SameSite=Strict, scoped and short-lived', async () => {
    const { app, db } = server();
    const phone = new Phone(app, ORIGIN);
    const res = await phone.request('/api/auth/login/options', { deviceId: phone.deviceId });
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${FLOW_COOKIE}=`))!;
    expect(set).toMatch(/^bht_flow=[\w-]{43};/);
    expect(set).toMatch(/Max-Age=300/);
    expect(set).toMatch(/Path=\/api\/auth/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Strict/);
    // The body has no flow secret, and the database only its hash.
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['flowId', 'options']);
    const secret = phone.flow!.split('=')[1]!;
    expect(db.prepare('SELECT browser_hash FROM auth_flows').all()).toEqual([
      { browser_hash: hashSecret(secret) },
    ]);
  });
});

describe('phones and households', () => {
  test('a phone id held by another household is 409, and the row stays where it was', async () => {
    const { app, db } = server();
    const a = await register(app, ORIGIN);
    const b = await register(app, ORIGIN);
    const owner = () =>
      db.prepare('SELECT member_id FROM devices WHERE id = ?').get(a.phone.deviceId);
    const before = owner();
    expect(before).toEqual({ member_id: a.signedIn.memberId });
    // Login: the household is only known once the passkey answers.
    const login = await b.phone.ceremony('login', { deviceId: a.phone.deviceId });
    const res = await login.verify();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: DEVICE_ELSEWHERE });
    expect(owner()).toEqual(before);
    // Register and join are refused before the phone makes a passkey.
    const stranger = new Phone(app, ORIGIN);
    const reg = await stranger.request('/api/auth/register/options', {
      ...newHousehold(),
      deviceId: a.phone.deviceId,
    });
    expect(reg.status).toBe(409);
    const { code } = await b.phone.json<Invite>('/api/invites', {});
    const join = await stranger.request('/api/auth/join/options', {
      code,
      displayName: 'Sam',
      deviceId: a.phone.deviceId,
    });
    expect(join.status).toBe(409);
    // A still works; B signs in fine under a new id, as the step 3 client will.
    expect((await a.phone.request('/api/household')).status).toBe(200);
    const retry = await b.phone.ceremony('login', { deviceId: newId() });
    expect((await retry.verify()).status).toBe(200);
    expect(owner()).toEqual(before);
  });

  test('another member signing in on a phone ends the previous member’s session on it', async () => {
    const { app, db } = server();
    const maya = await register(app, ORIGIN);
    const { code } = await maya.phone.json<Invite>('/api/invites', {});
    const sam = new Phone(app, ORIGIN);
    const join = await sam.ceremony('join', {
      code,
      displayName: 'Sam',
      deviceId: maya.phone.deviceId,
    });
    const joined = await join.verify();
    expect(joined.status).toBe(200);
    const { memberId: samId } = (await joined.json()) as { memberId: string };
    expect(
      db.prepare('SELECT member_id FROM devices WHERE id = ?').get(maya.phone.deviceId),
    ).toEqual({ member_id: samId });
    expect((await maya.phone.request('/api/household')).status).toBe(401);
    expect((await sam.request('/api/household')).status).toBe(200);
    // Maya signing back in takes the phone back, and Sam's session there ends.
    maya.phone.cookie = null;
    const back = await maya.phone.ceremony('login', { deviceId: maya.phone.deviceId });
    expect((await back.verify()).status).toBe(200);
    expect((await maya.phone.request('/api/household')).status).toBe(200);
    expect((await sam.request('/api/household')).status).toBe(401);
    // Removing the phone ends whichever session is left on it.
    db.prepare('UPDATE devices SET removed_at = ? WHERE id = ?').run(
      '2026-10-29T04:00:00.000Z',
      maya.phone.deviceId,
    );
    expect((await maya.phone.request('/api/household')).status).toBe(401);
  });

  test('a session whose phone now belongs to someone else is dead even if not revoked', async () => {
    const { app, db } = server();
    const maya = await register(app, ORIGIN);
    const { code } = await maya.phone.json<Invite>('/api/invites', {});
    const sam = new Phone(app, ORIGIN);
    expect(
      (
        await (
          await sam.ceremony('join', { code, displayName: 'Sam', deviceId: sam.deviceId })
        ).verify()
      ).status,
    ).toBe(200);
    // Simulate a row written before revocation existed: the device moves, the session stays.
    const samId = (
      db.prepare('SELECT member_id FROM devices WHERE id = ?').get(sam.deviceId) as {
        member_id: string;
      }
    ).member_id;
    db.prepare('UPDATE devices SET member_id = ? WHERE id = ?').run(samId, maya.phone.deviceId);
    expect((await maya.phone.request('/api/household')).status).toBe(401);
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
