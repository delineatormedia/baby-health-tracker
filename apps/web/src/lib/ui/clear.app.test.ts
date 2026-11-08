import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { newId, type Baby } from '@bht/schema';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// The real server (#5), in process, with real cookie sessions: a clear is about who the
// server still lets in.
import { createApp } from '../../../../server/src/app.ts';
import { openDatabase as openServerDb } from '../../../../server/src/db.ts';
import { Phone, register } from '../../../../server/src/testing/phone.ts';
import { openDatabase } from '../data/db.ts';
import { EventStore } from '../data/store.ts';

// The whole phone's side of Clear all data (#85): the real AppState over a real EventStore,
// talking to the real server through a fetch stub that keeps this browser's cookies.

const ORIGIN = 'http://localhost';
const settle = () => new Promise((r) => setTimeout(r, 50));

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let kv: Map<string, string>;
let requests: { method: string; url: string }[];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  kv = new Map();
  requests = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => kv.set(k, v),
    removeItem: (k: string) => kv.delete(k),
    key: (i: number) => [...kv.keys()][i] ?? null,
    get length() {
      return kv.size;
    },
  });
  vi.stubGlobal('location', new URL('http://localhost/'));
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  });
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
  vi.stubGlobal('navigator', { locks: undefined });
  vi.stubGlobal('BroadcastChannel', undefined);
});
afterEach(async () => {
  // Each app's sync client is stopped here, before the globals go: left running, a failed run's
  // backoff retry would land in a later test's request log.
  for (const app of loaded.splice(0)) await app.dispose();
  vi.doUnmock('../data/account.ts');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The apps this test loaded, for afterEach to stop. */
const loaded: { dispose(): Promise<void> }[] = [];

async function loadApp() {
  const { app } = await import('./app.svelte.ts');
  loaded.push(app);
  await app.init();
  return app;
}

const pushes = () => requests.filter((r) => r.method === 'POST' && r.url === '/api/sync');

/**
 * A server with one household, registered by phone A. `browser` is this app's fetch: requests
 * go to the server with the cookies this browser holds, and Set-Cookie updates them, so the
 * app's session is whatever the server last gave it. The app starts signed in as A.
 */
async function household() {
  const db = openServerDb(':memory:');
  const server = createApp(db, {
    auth: { rpId: 'localhost', origin: ORIGIN, rpName: 'Test' },
    log: () => {},
  });
  const a = await register(server, ORIGIN);
  const baby: Baby = { ...a.home.baby, householdId: a.home.householdId };
  const jar = new Map<string, string>();
  if (a.phone.cookie) jar.set('bht_session', a.phone.cookie);
  const browser: Fetch = async (url, init) => {
    requests.push({ method: init?.method ?? 'GET', url });
    const headers: Record<string, string> = {
      origin: ORIGIN,
      ...(init?.headers as Record<string, string> | undefined),
    };
    const cookie = [...jar.values()].join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await server.request(url, { ...init, headers });
    for (const set of res.headers.getSetCookie()) {
      const pair = set.split(';')[0]!;
      const name = pair.split('=')[0]!;
      if (pair.endsWith('=')) jar.delete(name);
      else jar.set(name, pair);
    }
    return res;
  };
  vi.stubGlobal('fetch', vi.fn(browser));
  kv.set('bht.author', a.phone.deviceId);
  kv.set('bht.baby', JSON.stringify(baby));
  kv.set('bht.setupAt', String(Date.parse('2026-10-02T00:00:00.000Z')));
  kv.set('bht.welcomed', '1');
  kv.set(
    'bht.account',
    JSON.stringify({ householdId: a.home.householdId, memberId: a.signedIn.memberId }),
  );
  kv.set(`bht.late.${a.home.householdId}`, '[]');
  const count = (table: 'babies' | 'event_versions') =>
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE household_id = ?`)
        .get(a.home.householdId) as { n: number }
    ).n;
  const holds = (eventId: string) =>
    db.prepare('SELECT 1 FROM event_versions WHERE event_id = ?').get(eventId) !== undefined;
  /** The other parent's phone: the same passkey, signed in on another device. */
  const otherPhone = async () => {
    const phone = new Phone(server, ORIGIN, a.phone.passkeys);
    const { verify } = await phone.ceremony('login', { deviceId: phone.deviceId });
    expect((await verify()).status).toBe(200);
    return phone;
  };
  /** The browser's passkey prompts answer with phone A's authenticator. */
  const mockPasskeys = () =>
    vi.doMock('../data/account.ts', async (original) => ({
      ...(await original<typeof import('../data/account.ts')>()),
      browserPasskeys: () => ({
        get: async (options: unknown) => a.phone.passkeys.get(options as never),
        create: async (options: unknown) => a.phone.passkeys.create(options as never),
      }),
    }));
  return { db, server, a, baby, jar, count, holds, otherPhone, mockPasskeys };
}

const wet = (store: EventStore, babyId: string) => store.log(babyId, 'diaper', { kind: 'wet' });

/** Everything a wipe leaves: prefs, the author id and the notice. */
const localKeys = () => [...kv.keys()].sort();

describe('Settings → Clear all data', () => {
  test('the server deletes everything and signs every phone out; this phone drops its copy and is back at the welcome screen', async () => {
    const h = await household();
    const other = await otherPhone(h);
    const theirs = await other.push([
      {
        id: newId(),
        babyId: h.baby.id,
        authorId: other.deviceId,
        occurredAt: '2026-10-29T02:00:00.000Z',
        recordedAt: '2026-10-29T02:00:00.000Z',
        version: 1,
        deleted: false,
        notes: null,
        type: 'diaper' as const,
        data: { kind: 'wet' as const },
      },
    ]);
    expect(theirs.results[0]).toMatchObject({ status: 'accepted' });
    const app = await loadApp();
    const { event } = await wet(app.store, h.baby.id);
    await vi.waitFor(() => expect(h.holds(event.id)).toBe(true));
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(h.count('babies')).toBe(1);

    await app.clearData();

    // The server: no babies, no versions, and no session left for any phone.
    expect(h.count('babies')).toBe(0);
    expect(h.count('event_versions')).toBe(0);
    expect(h.jar.has('bht_session')).toBe(false);
    expect((await other.request('/api/sync?after=0&limit=10')).status).toBe(401);
    expect((await other.request('/api/sync', { schemaVersion: 6, events: [] })).status).toBe(401);
    // This phone: nothing left but prefs, author and the notice; back at the welcome screen.
    expect(app.baby).toBeNull();
    expect(app.account).toBeNull();
    expect(app.events).toEqual([]);
    expect(app.setupAt).toBeNull();
    expect(app.welcomed).toBe(false);
    expect(app.showWelcome).toBe(true);
    expect(app.syncStatus).toBe('idle');
    expect(app.wipeNotice).toMatchObject({ reason: 'cleared' });
    expect(await app.store.db.getAll('versions')).toEqual([]);
    expect(await app.store.db.getAll('meta')).toEqual([]);
    expect(localKeys()).toEqual(['bht.author', 'bht.wiped']);
    // No request goes out after the clear: sync is gone with the session.
    const sent = requests.length;
    await settle();
    expect(requests.length).toBe(sent);
    app.dismissWipeNotice();
    expect(app.wipeNotice).toBeNull();
    expect(kv.has('bht.wiped')).toBe(false);
  });

  test('a request that does not reach the server deletes nothing, here or there, and sync carries on', async () => {
    const h = await household();
    const real = globalThis.fetch;
    let down = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (down && url === '/api/household/clear') throw new TypeError('Failed to fetch');
        return real(url, init);
      }),
    );
    const app = await loadApp();
    const { event } = await wet(app.store, h.baby.id);
    await vi.waitFor(() => expect(h.holds(event.id)).toBe(true));

    const { clearFailure } = await import('./app.svelte.ts');
    await expect(app.clearData()).rejects.toBeInstanceOf(TypeError);
    expect(clearFailure(new TypeError('Failed to fetch'))).toBe(
      'Nothing was deleted: No connection to the server. Try again.',
    );
    expect(app.baby).toEqual(h.baby);
    expect(app.account?.householdId).toBe(h.baby.householdId);
    expect(await app.store.events(h.baby.id)).toHaveLength(1);
    expect(h.count('event_versions')).toBe(1);
    // Sync is back: a new entry reaches the server.
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    const next = await wet(app.store, h.baby.id);
    await vi.waitFor(() => expect(h.holds(next.event.id)).toBe(true));

    down = false;
    await app.clearData();
    expect(h.count('event_versions')).toBe(0);
    expect(app.baby).toBeNull();
  });
});

describe('the other phone', () => {
  test('is refused on its next sync, drops its copy and its pending entry with it, and signs in again to start over', async () => {
    const h = await household();
    // This browser is the other phone now: its own device, signed in, with an entry it has
    // not synced yet. Phone A clears while it is offline.
    const other = await otherPhone(h);
    h.jar.set('bht_session', other.cookie!);
    kv.set('bht.author', other.deviceId);
    const store = new EventStore(await openDatabase(), other.deviceId);
    const pending = await wet(store, h.baby.id);
    expect((await h.a.phone.request('/api/household/clear', {})).status).toBe(200);
    // The passkey prompts later in this test answer with the household's authenticator.
    h.mockPasskeys();

    const app = await loadApp();
    await vi.waitFor(() => expect(app.account).toBeNull());
    // The baby add before the push was refused, so nothing was uploaded; the entry never
    // reached the server and is gone from this phone.
    expect(requests.filter((r) => r.url === '/api/babies')).toHaveLength(1);
    expect(pushes()).toHaveLength(0);
    expect(h.holds(pending.event.id)).toBe(false);
    expect(h.count('event_versions')).toBe(0);
    expect(app.baby).toBeNull();
    expect(app.showWelcome).toBe(true);
    expect(app.wipeNotice).toMatchObject({ reason: 'signed_out' });
    expect(await app.store.db.getAll('versions')).toEqual([]);
    expect(localKeys()).toEqual(['bht.author', 'bht.wiped']);
    expect(app.syncStatus).toBe('idle');

    // Start over: the welcome screen, a new baby, then Sign in with the passkey.
    app.passWelcome();
    const next: Baby = { ...h.baby, id: newId(), name: 'Next' };
    app.setBaby(next);
    await app.signIn((account, signal) => account.login(signal));
    expect(app.account?.householdId).toBe(h.baby.householdId);
    expect(app.baby).toEqual(next);
    const entry = await wet(app.store, next.id);
    await vi.waitFor(() => expect(h.holds(entry.event.id)).toBe(true));
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(h.count('babies')).toBe(1);
    expect(h.count('event_versions')).toBe(1);
    expect(
      h.db.prepare('SELECT id FROM babies WHERE household_id = ?').all(h.baby.householdId),
    ).toEqual([{ id: next.id }]);
  });

  test('signed out before the clear, it cannot bring its old baby back: the server refuses it and the copy goes', async () => {
    const h = await household();
    // Signed out before the clear, logs kept on the phone (step 3b): no account, pending rows.
    kv.delete('bht.account');
    h.jar.delete('bht_session');
    const store = new EventStore(await openDatabase(), h.a.phone.deviceId);
    const old = await wet(store, h.baby.id);
    expect((await h.a.phone.request('/api/household/clear', {})).status).toBe(200);
    h.mockPasskeys();

    const app = await loadApp();
    expect(app.baby).toEqual(h.baby);
    await app.signIn((account, signal) => account.login(signal));
    // Signed in; the first sync tries to add the baby back and is told it was cleared.
    await vi.waitFor(() => expect(app.account).toBeNull());
    expect(h.count('babies')).toBe(0);
    expect(h.count('event_versions')).toBe(0);
    expect(h.holds(old.event.id)).toBe(false);
    expect(pushes()).toHaveLength(0);
    expect(app.baby).toBeNull();
    expect(app.wipeNotice).toMatchObject({ reason: 'signed_out' });
    expect(await app.store.db.getAll('versions')).toEqual([]);
    expect(localKeys()).toEqual(['bht.author', 'bht.wiped']);
  });
});

describe('other tabs', () => {
  test('hear about the clear and drop their state too', async () => {
    const channels = new Set<{ onmessage: ((e: { data: unknown }) => void) | null }>();
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage: ((e: { data: unknown }) => void) | null = null;
        constructor() {
          channels.add(this);
        }
        postMessage(data: unknown) {
          for (const c of channels) if (c !== this) queueMicrotask(() => c.onmessage?.({ data }));
        }
      },
    );
    const h = await household();
    const a = await loadApp();
    vi.resetModules();
    const b = await loadApp();
    expect(b).not.toBe(a);
    await vi.waitFor(() => expect(b.syncStatus).toBe('idle'));
    expect(b.baby).toEqual(h.baby);

    await a.clearData();
    await vi.waitFor(() => expect(b.account).toBeNull());
    expect(b.baby).toBeNull();
    expect(b.showWelcome).toBe(true);
    expect(b.wipeNotice).toMatchObject({ reason: 'cleared' });
    expect(b.syncStatus).toBe('idle');
    const sent = requests.length;
    await settle();
    expect(requests.length).toBe(sent);
  });
});

/** The other parent's phone, signed in to A's household. */
const otherPhone = (h: Awaited<ReturnType<typeof household>>) => h.otherPhone();
