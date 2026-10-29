import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { newId, type BabyEvent, type SignedIn } from '@bht/schema';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openDatabase } from '../data/db.ts';
import { SEEDED_REFUSAL } from '../data/seeded.ts';
import { EventStore } from '../data/store.ts';

// App-level account transitions (#55 review): the real AppState over a real EventStore, with
// fetch answered (or held) by each test.

const baby = (householdId = newId()) => ({
  id: newId(),
  householdId,
  name: 'Fixture',
  birthAt: '2026-10-01T00:00:00.000Z',
  sex: 'female' as const,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const emptyPull = (next = 0) => ({ versions: [], next, through: next, more: false });
/** Lets held promises, IndexedDB transactions and follow-up requests run out. */
const settle = () => new Promise((r) => setTimeout(r, 50));
const held = () => {
  let release!: (r: Response) => void;
  const response = new Promise<Response>((r) => (release = r));
  return { response, release };
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let kv: Map<string, string>;
let requests: string[];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  kv = new Map();
  requests = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => kv.set(k, v),
    removeItem: (k: string) => kv.delete(k),
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  });
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function serve(handler: Fetch) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      return handler(url, init);
    }),
  );
}

const pushes = () => requests.filter((r) => r === 'POST /api/sync');
const pulls = () => requests.filter((r) => r.startsWith('GET /api/sync?'));

async function loadApp() {
  const { app } = await import('./app.svelte.ts');
  await app.init();
  return app;
}

const signedIn = (householdId: string) => async () =>
  ({ householdId, memberId: newId() }) as SignedIn;

describe('sign-out fences the sync run in flight', () => {
  test('a pull answered after sign-out leaves the reset cursor alone and pages no further', async () => {
    const old = baby();
    kv.set('bht.baby', JSON.stringify(old));
    kv.set('bht.account', JSON.stringify({ householdId: old.householdId, memberId: newId() }));
    await (await openDatabase()).put('meta', 5, `cursor:${old.householdId}`);
    const pull = held();
    serve(async (url) => (url.startsWith('/api/sync?') ? pull.response : json({})));
    const app = await loadApp();
    await vi.waitFor(() => expect(pulls()).toHaveLength(1));
    expect(pulls()[0]).toContain('after=5');

    await app.signOut();
    expect(await app.store.cursor(old.householdId)).toBe(0);
    pull.release(json({ versions: [], next: 91, through: 200, more: true }));
    await settle();

    expect(await app.store.cursor(old.householdId)).toBe(0);
    expect(await app.store.cursor()).toBe(0);
    expect(pulls()).toHaveLength(1);
    expect(app.account).toBeNull();
    expect(app.syncStatus).toBe('idle');
  });

  test('a push answered after sign-out stores nothing and the entry stays pending', async () => {
    const old = baby();
    kv.set('bht.baby', JSON.stringify(old));
    kv.set('bht.account', JSON.stringify({ householdId: old.householdId, memberId: newId() }));
    const store = new EventStore(await openDatabase(), newId());
    await store.log(old.id, 'diaper', { kind: 'wet' });
    const push = held();
    serve(async (url, init) => {
      if (url === '/api/sync' && init?.method === 'POST') return push.response;
      if (url === '/api/babies') return json(old);
      return json(emptyPull());
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    const [sent] = (await app.store.pending(10)) as [BabyEvent];

    await app.signOut();
    push.release(
      json({ results: [{ id: sent.id, version: sent.version, status: 'accepted', seq: 7 }] }),
    );
    await settle();

    expect(await app.store.pending(10)).toEqual([sent]);
    expect(await app.store.hasSynced(old.id)).toBe(false);
    expect(pulls()).toHaveLength(0);
    expect(app.syncStatus).toBe('idle');
  });

  test('a prepare answered after sign-out sends no push', async () => {
    const old = baby();
    kv.set('bht.baby', JSON.stringify(old));
    kv.set('bht.account', JSON.stringify({ householdId: old.householdId, memberId: newId() }));
    const store = new EventStore(await openDatabase(), newId());
    await store.log(old.id, 'diaper', { kind: 'wet' });
    const addBaby = held();
    serve(async (url) => (url === '/api/babies' ? addBaby.response : json(emptyPull())));
    const app = await loadApp();
    await vi.waitFor(() => expect(requests).toContain('POST /api/babies'));

    await app.signOut();
    addBaby.release(json(old));
    await settle();

    expect(pushes()).toHaveLength(0);
    expect(pulls()).toHaveLength(0);
    expect(await app.store.pending(10)).toHaveLength(1);
  });
});

describe('the pull cursor belongs to its household', () => {
  test('after a 401, signing in to another household pulls it from 0', async () => {
    const a = baby();
    const b = baby();
    kv.set('bht.baby', JSON.stringify(a));
    kv.set('bht.account', JSON.stringify({ householdId: a.householdId, memberId: newId() }));
    await (await openDatabase()).put('meta', 91, `cursor:${a.householdId}`);
    let session = false;
    serve(async (url) => {
      if (url === '/api/household') return json({ id: b.householdId, members: [], babies: [b] });
      if (url.startsWith('/api/sync?')) return session ? json(emptyPull(20)) : json({}, 401);
      return json({});
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('signed_out'));
    expect(pulls()[0]).toContain('after=91');

    // No explicit sign-out: the expired session's account is replaced by B's.
    await app.signIn(async () => {
      session = true;
      return signedIn(b.householdId)();
    });
    await vi.waitFor(() => expect(pulls()).toHaveLength(2));

    expect(pulls()[1]).toContain('after=0');
    await vi.waitFor(async () => expect(await app.store.cursor(b.householdId)).toBe(20));
    expect(await app.store.cursor(a.householdId)).toBe(91);
  });

  test('after a 401, signing back in to the same household keeps its cursor', async () => {
    const a = baby();
    kv.set('bht.baby', JSON.stringify(a));
    kv.set('bht.account', JSON.stringify({ householdId: a.householdId, memberId: newId() }));
    await (await openDatabase()).put('meta', 91, `cursor:${a.householdId}`);
    let session = false;
    serve(async (url) => {
      if (url === '/api/household') return json({ id: a.householdId, members: [], babies: [a] });
      if (url.startsWith('/api/sync?')) return session ? json(emptyPull(95)) : json({}, 401);
      return json({});
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('signed_out'));

    await app.signIn(async () => {
      session = true;
      return signedIn(a.householdId)();
    });
    await vi.waitFor(() => expect(pulls()).toHaveLength(2));

    expect(pulls()[1]).toContain('after=91');
  });
});

describe('placement goes by stored rows', () => {
  test('an undone entry still asks before joining, and keeping it off uploads nothing', async () => {
    const old = baby();
    const target = baby();
    kv.set('bht.baby', JSON.stringify(old));
    const store = new EventStore(await openDatabase(), newId());
    await (await store.log(old.id, 'diaper', { kind: 'wet' })).undo();
    const pushed: BabyEvent[] = [];
    serve(async (url, init) => {
      if (url === '/api/household')
        return json({ id: target.householdId, members: [], babies: [target] });
      if (url === '/api/sync') {
        const { events } = JSON.parse(init!.body as string) as { events: BabyEvent[] };
        pushed.push(...events);
        return json({
          results: events.map((e) => ({
            id: e.id,
            version: e.version,
            status: 'accepted',
            seq: 1,
          })),
        });
      }
      return json(emptyPull());
    });
    const app = await loadApp();
    expect(app.events).toHaveLength(0);

    await app.signIn(signedIn(target.householdId));
    await settle();
    expect(app.joining).toEqual(target);
    expect(pushed).toEqual([]);
    expect(requests).not.toContain('POST /api/babies');

    await app.settleJoin(false);
    await settle();
    expect(app.baby).toEqual(target);
    expect(pushed.filter((e) => e.babyId === old.id)).toEqual([]);
    expect(await app.store.rejectedCount()).toBe(0);
  });

  test('moving an undone entry carries its tombstone into the household baby', async () => {
    const old = baby();
    const target = baby();
    kv.set('bht.baby', JSON.stringify(old));
    const store = new EventStore(await openDatabase(), newId());
    await (await store.log(old.id, 'diaper', { kind: 'wet' })).undo();
    const pushed: BabyEvent[] = [];
    serve(async (url, init) => {
      if (url === '/api/household')
        return json({ id: target.householdId, members: [], babies: [target] });
      if (url === '/api/sync') {
        const { events } = JSON.parse(init!.body as string) as { events: BabyEvent[] };
        pushed.push(...events);
        return json({
          results: events.map((e) => ({
            id: e.id,
            version: e.version,
            status: 'accepted',
            seq: 1,
          })),
        });
      }
      return json(emptyPull());
    });
    const app = await loadApp();
    await app.signIn(signedIn(target.householdId));
    expect(app.joining).toEqual(target);

    await app.settleJoin(true);
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]).toMatchObject({ babyId: target.id, deleted: true });
    expect(app.events).toEqual([]);
  });
});

describe('a seeded dev browser stays off real servers', () => {
  test('signed in on a real server, its test entries stay pending and nothing is sent', async () => {
    vi.stubGlobal('location', new URL('https://bht.example/'));
    const old = baby();
    kv.set('bht.seeded', '1');
    kv.set('bht.baby', JSON.stringify(old));
    kv.set('bht.account', JSON.stringify({ householdId: old.householdId, memberId: newId() }));
    const store = new EventStore(await openDatabase(), newId());
    await store.log(old.id, 'diaper', { kind: 'wet' });
    serve(async () => json(emptyPull()));
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('offline'));

    expect(app.syncError).toBe(SEEDED_REFUSAL);
    expect(requests).toEqual([]);
    expect(await app.store.pending(10)).toHaveLength(1);
  });

  test('signing in to a real server is refused before any request', async () => {
    vi.stubGlobal('location', new URL('https://bht.example/'));
    kv.set('bht.seeded', '1');
    kv.set('bht.baby', JSON.stringify(baby()));
    serve(async () => json({}));
    const app = await loadApp();

    await expect(app.signIn((account) => account.login())).rejects.toThrow(SEEDED_REFUSAL);
    expect(requests).toEqual([]);
    expect(app.account).toBeNull();
  });

  test('on localhost it syncs as usual', async () => {
    vi.stubGlobal('location', new URL('http://localhost:5173/'));
    const old = baby();
    kv.set('bht.seeded', '1');
    kv.set('bht.baby', JSON.stringify(old));
    kv.set('bht.account', JSON.stringify({ householdId: old.householdId, memberId: newId() }));
    serve(async () => json(emptyPull()));
    const app = await loadApp();
    await vi.waitFor(() => expect(pulls()).toHaveLength(1));
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
  });
});
