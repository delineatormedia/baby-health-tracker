import { DEVICE_ELSEWHERE, DEVICE_REMOVED, newId, type SignedIn } from '@bht/schema';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
// The real server (#5), in process, with the server tests' software passkey authenticator.
import { createApp } from '../../../../server/src/app.ts';
import { openDatabase } from '../../../../server/src/db.ts';
import { SoftAuthenticator } from '../../../../server/src/testing/authenticator.ts';
import {
  Account,
  AccountError,
  isDeviceRefusal,
  signInFailure,
  type AccountTransport,
} from './account.ts';

const origin = 'https://bht.test';
let db: DatabaseSync;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDatabase(':memory:');
  app = createApp(db, { auth: { rpId: 'bht.test', origin } });
});

/**
 * httpAccount's requests, sent to the in-process app from the app's origin, with the
 * browser's cookie jar. `sent` records each request's path and body.
 */
function browser() {
  const jar = new Map<string, string>();
  const sent: { path: string; body?: unknown }[] = [];
  async function call<T>(path: string, body?: unknown): Promise<T> {
    sent.push({ path, body });
    const headers: Record<string, string> = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers.origin = origin;
    }
    const res = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const set of res.headers.getSetCookie()) {
      const [name, value] = set.split(';')[0]!.split('=') as [string, string];
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    const json = (await res.json()) as { error?: string };
    if (!res.ok) throw new AccountError(res.status, json.error ?? '');
    return json as T;
  }
  const http: AccountTransport = { get: (p) => call(p), post: (p, b) => call(p, b) };
  return { http, jar, sent };
}

/** A phone: its browser, passkeys and device id. `prompts` counts passkey prompts. */
function phone(passkeys = new SoftAuthenticator(origin)) {
  const b = browser();
  const ids = [newId()];
  const prompts = { create: 0, get: 0 };
  let credential: string | undefined;
  const account = new Account(
    b.http,
    {
      create: async (o) => {
        prompts.create += 1;
        const r = passkeys.create(o as unknown as PublicKeyCredentialCreationOptionsJSON);
        credential = r.id;
        return r;
      },
      get: async (o) => {
        prompts.get += 1;
        return passkeys.get(o as unknown as PublicKeyCredentialRequestOptionsJSON, credential);
      },
    },
    {
      get: () => ids.at(-1)!,
      mint: () => {
        ids.push(newId());
        return ids.at(-1)!;
      },
    },
  );
  /** Signs in with a passkey made elsewhere (another household's, say). */
  const usePasskey = (id: string) => (credential = id);
  return { account, ids, prompts, passkeys, usePasskey, ...b };
}

const baby = () => ({
  id: newId(),
  name: 'Pip',
  birthAt: '2026-10-20T08:15:00.000Z',
  sex: 'female' as const,
});

async function household(p = phone()) {
  const local = baby();
  const householdId = newId();
  const signedIn = await p.account.register({ householdId, displayName: 'Maya', baby: local });
  return { p, local, householdId, signedIn };
}

describe('Account against the real server', () => {
  test('register, invite, join: both phones see one household and its baby', async () => {
    const { p: maya, local, householdId, signedIn } = await household();
    expect(signedIn.householdId).toBe(householdId);
    expect(maya.jar.has('bht_session')).toBe(true);
    // The flow cookie is gone once the ceremony finishes.
    expect(maya.jar.has('bht_flow')).toBe(false);

    const { code } = await maya.account.invite();
    const sam = phone();
    const joined = await sam.account.join({ code, displayName: 'Sam' });
    expect(joined.householdId).toBe(householdId);

    const view = await sam.account.household();
    expect(view.members.map((m) => m.displayName)).toEqual(['Maya', 'Sam']);
    expect(view.babies).toEqual([{ ...local, householdId }]);
  });

  test('every POST is JSON, logout included, and ends the session', async () => {
    const { p } = await household();
    await p.account.logout();
    expect(p.sent.at(-1)).toEqual({ path: '/api/auth/logout', body: {} });
    expect(p.jar.has('bht_session')).toBe(false);
    await expect(p.account.household()).rejects.toMatchObject({ status: 401 });
  });

  test('a returning member logs in with the passkey on this phone', async () => {
    const { p, householdId, signedIn } = await household();
    await p.account.logout();
    expect(await p.account.login()).toEqual(signedIn);
    expect((await p.account.household()).id).toBe(householdId);
  });

  test('addBaby adds a second child once; a retry is safe', async () => {
    const { p, householdId } = await household();
    const second = baby();
    expect(await p.account.addBaby(second)).toEqual({ ...second, householdId });
    expect(await p.account.addBaby(second)).toEqual({ ...second, householdId });
    expect((await p.account.household()).babies).toHaveLength(2);
  });

  test('a removed phone mints a new id and logs in again with a second prompt', async () => {
    const { p, signedIn } = await household();
    await p.account.logout();
    db.prepare('UPDATE devices SET removed_at = ? WHERE id = ?').run(
      '2026-10-29T04:00:00.000Z',
      p.ids[0]!,
    );

    expect(await p.account.login()).toEqual(signedIn);
    expect(p.ids).toHaveLength(2);
    // A login is refused only at verify, once the passkey has answered.
    expect(p.prompts.get).toBe(2);
    const verifies = p.sent.filter((s) => s.path === '/api/auth/login/verify');
    expect(verifies).toHaveLength(2);
    const options = p.sent.filter((s) => s.path === '/api/auth/login/options');
    expect(options.map((s) => s.body)).toEqual([{ deviceId: p.ids[0] }, { deviceId: p.ids[1] }]);
    const device = db.prepare('SELECT member_id FROM devices WHERE id = ?').get(p.ids[1]!);
    expect(device).toEqual({ member_id: signedIn.memberId });
  });

  test('a phone id held by another household is replaced before join makes a passkey', async () => {
    const { p: maya } = await household();
    const other = await household();
    const { code } = await other.p.account.invite();
    // The same phone id as Maya's phone, joining a different household.
    const { account, ids, prompts } = phone();
    ids[0] = maya.ids[0]!;

    const joined = await account.join({ code, displayName: 'Sam' });
    expect(joined.householdId).toBe(other.householdId);
    expect(ids).toHaveLength(2);
    expect(prompts.create).toBe(1);
    // Maya's phone is untouched.
    const row = db.prepare('SELECT member_id FROM devices WHERE id = ?').get(maya.ids[0]!);
    expect(row).toEqual({ member_id: (await maya.account.household()).members[0]!.id });
  });

  test('register with a phone id another household holds mints one before the passkey', async () => {
    const { p: maya } = await household();
    const p = phone();
    p.ids[0] = maya.ids[0]!;
    const { signedIn } = await household(p);
    expect(signedIn.householdId).not.toBe((await maya.account.household()).id);
    expect(p.ids).toHaveLength(2);
    expect(p.prompts.create).toBe(1);
  });

  test("a login with another household's passkey on this phone id mints a new id", async () => {
    const shared = new SoftAuthenticator(origin);
    // One phone, two households' passkeys: Maya's, then (after signing out) Sam's own.
    const first = await household(phone(shared));
    await first.p.account.logout();
    const second = await household(phone(shared));
    await second.p.account.logout();

    const p = phone(shared);
    p.ids[0] = first.p.ids[0]!;
    p.usePasskey(
      db.prepare('SELECT id FROM credentials WHERE member_id = ?').get(second.signedIn.memberId)!
        .id as string,
    );
    const signedIn: SignedIn = await p.account.login();
    expect(signedIn).toEqual(second.signedIn);
    expect(p.ids).toHaveLength(2);
    expect(p.prompts.get).toBe(2);
  });

  test('other refusals are not retried and keep the server reason', async () => {
    const p = phone();
    const err = await p.account.join({ code: '0123456789', displayName: 'Sam' }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(signInFailure(err)).toBe('Invite not found or expired');
    expect(p.ids).toHaveLength(1);
  });

  test('a second refusal after a fresh id is not retried again', async () => {
    const p = phone();
    let calls = 0;
    const refusing = new Account(
      {
        get: () => Promise.reject(new Error('unused')),
        post: async <T>(path: string) => {
          calls += 1;
          if (path.endsWith('/options')) throw new AccountError(409, DEVICE_ELSEWHERE);
          return {} as T;
        },
      },
      { create: async () => ({}), get: async () => ({}) },
      { get: () => p.ids.at(-1)!, mint: () => (p.ids.push(newId()), p.ids.at(-1)!) },
    );
    await expect(refusing.join({ code: '0123456789', displayName: 'Sam' })).rejects.toThrow(
      DEVICE_ELSEWHERE,
    );
    expect(calls).toBe(2);
    expect(p.ids).toHaveLength(2);
  });

  test('only the two phone-id refusals, with their exact status, mint a new id', () => {
    expect(isDeviceRefusal(new AccountError(401, DEVICE_REMOVED))).toBe(true);
    expect(isDeviceRefusal(new AccountError(409, DEVICE_ELSEWHERE))).toBe(true);
    expect(isDeviceRefusal(new AccountError(401, 'Sign-in expired; start again'))).toBe(false);
    expect(isDeviceRefusal(new AccountError(409, 'Household exists'))).toBe(false);
    expect(isDeviceRefusal(new AccountError(409, DEVICE_REMOVED))).toBe(false);
  });
});

describe('signInFailure', () => {
  test('a dismissed passkey prompt reads as cancelled', () => {
    const e = Object.assign(new Error('The operation either timed out or was not allowed.'), {
      name: 'NotAllowedError',
    });
    expect(signInFailure(e)).toBe('Passkey cancelled. Try again.');
  });

  test('a network failure reads as no connection', () => {
    expect(signInFailure(new TypeError('Failed to fetch'))).toBe(
      'No connection to the server. Try again.',
    );
  });
});
