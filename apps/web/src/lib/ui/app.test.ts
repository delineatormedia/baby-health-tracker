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
    key: (i: number) => [...kv.keys()][i] ?? null,
    get length() {
      return kv.size;
    },
  });
  // init() reads ?seed in dev builds (#60); tests that need a real host stub their own.
  vi.stubGlobal('location', new URL('http://localhost/'));
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

describe('an account transition fences placement in flight', () => {
  /** A phone that signed in to A before reloading, with A's household load held open. */
  function unplacedA() {
    const a = baby();
    kv.set('bht.baby', JSON.stringify(a));
    kv.set(
      'bht.account',
      JSON.stringify({ householdId: a.householdId, memberId: newId(), placed: false }),
    );
    return a;
  }

  test('placement answered after sign-out stays signed out, with sync stopped', async () => {
    const a = unplacedA();
    const household = held();
    serve(async (url) => (url === '/api/household' ? household.response : json(emptyPull())));
    const app = await loadApp();
    await vi.waitFor(() => expect(requests).toContain('GET /api/household'));

    await app.signOut();
    household.release(json({ id: a.householdId, members: [], babies: [a] }));
    await settle();

    expect(app.account).toBeNull();
    expect(kv.has('bht.account')).toBe(false);
    expect(app.syncStatus).toBe('idle');
    expect(pulls()).toHaveLength(0);
  });

  test("A's placement answered after signing in to B leaves B's account and baby", async () => {
    const a = unplacedA();
    const b = baby();
    const householdA = held();
    let loads = 0;
    serve(async (url) => {
      if (url === '/api/household') {
        return ++loads === 1
          ? householdA.response
          : json({ id: b.householdId, members: [], babies: [b] });
      }
      return json(emptyPull());
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(loads).toBe(1));

    await app.signOut();
    await app.signIn(signedIn(b.householdId));
    const signedInB = { ...app.account };
    householdA.release(json({ id: a.householdId, members: [], babies: [a] }));
    await settle();

    expect(app.account).toEqual(signedInB);
    expect(app.account?.householdId).toBe(b.householdId);
    expect(JSON.parse(kv.get('bht.account')!).householdId).toBe(b.householdId);
    expect(app.baby?.id).toBe(b.id);
    expect(JSON.parse(kv.get('bht.baby')!).id).toBe(b.id);
  });

  test("A's failed placement after signing in to B shows B no error", async () => {
    unplacedA();
    const b = baby();
    const householdA = held();
    let loads = 0;
    serve(async (url) => {
      if (url === '/api/household') {
        return ++loads === 1
          ? householdA.response
          : json({ id: b.householdId, members: [], babies: [b] });
      }
      return json(emptyPull());
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(loads).toBe(1));

    await app.signIn(signedIn(b.householdId));
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    householdA.release(json({ error: 'boom' }, 500));
    await settle();

    expect(app.account?.householdId).toBe(b.householdId);
    expect(app.account?.placed).toBeUndefined();
    expect(app.baby?.id).toBe(b.id);
    expect(app.syncError).toBeNull();
    expect(app.syncStatus).not.toBe('offline');
    expect(app.toast).toBeNull();
  });

  test('a failed sign-out during placement puts the placement back', async () => {
    const a = unplacedA();
    const first = held();
    let loads = 0;
    serve(async (url) => {
      if (url === '/api/household') {
        return ++loads === 1
          ? first.response
          : json({ id: a.householdId, members: [], babies: [a] });
      }
      if (url === '/api/auth/logout') return json({ error: 'down' }, 503);
      return json(emptyPull());
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(loads).toBe(1));

    await expect(app.signOut()).rejects.toThrow();
    first.release(json({ id: a.householdId, members: [], babies: [a] }));
    await vi.waitFor(() => expect(app.account?.placed).toBeUndefined());

    expect(loads).toBe(2);
    expect(app.account?.householdId).toBe(a.householdId);
    await vi.waitFor(() => expect(pulls().length).toBeGreaterThan(0));
  });
});

describe('a sign-out aborts the sign-in in flight, and waits for its verify', () => {
  /**
   * A phone whose session expired: Settings shows both the login button and Sign out. The
   * server's session follows verify and logout; every other route is 401 without one.
   */
  async function expiredWithLogin(answer: Partial<Record<string, Promise<Response>>>) {
    const a = baby();
    kv.set('bht.baby', JSON.stringify(a));
    kv.set('bht.account', JSON.stringify({ householdId: a.householdId, memberId: newId() }));
    const server = { session: false };
    const prompts: AbortSignal[] = [];
    const credential = answer.credential;
    const passkey = vi.fn(async (_options: unknown, signal?: AbortSignal) => {
      prompts.push(signal!);
      return credential ? credential.then((r) => r.json()) : {};
    });
    vi.doMock('../data/account.ts', async (original) => ({
      ...(await original<typeof import('../data/account.ts')>()),
      browserPasskeys: () => ({ get: passkey, create: passkey }),
    }));
    serve(async (url) => {
      if (url === '/api/auth/login/options') {
        return answer.options ?? json({ flowId: newId(), options: {} });
      }
      if (url === '/api/auth/login/verify') {
        const res = await (answer.verify ?? json({}));
        server.session = true;
        return json({ householdId: a.householdId, memberId: newId() }, res.status);
      }
      if (url === '/api/auth/logout') {
        server.session = false;
        return json({});
      }
      if (url === '/api/household' && server.session) {
        return json({ id: a.householdId, members: [], babies: [a] });
      }
      return json({ error: 'Signed out' }, 401);
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('signed_out'));
    return { app, server, passkey, prompts };
  }
  const verifies = () => requests.filter((r) => r === 'POST /api/auth/login/verify');
  afterEach(() => vi.doUnmock('../data/account.ts'));

  test('sign-out before options returns: no passkey prompt, no verify', async () => {
    const options = held();
    const { app, server, passkey } = await expiredWithLogin({ options: options.response });
    const login = app.signIn((account, signal) => account.login(signal));
    await vi.waitFor(() => expect(requests).toContain('POST /api/auth/login/options'));

    const out = app.signOut();
    options.release(json({ flowId: newId(), options: {} }));
    await Promise.all([login, out]);
    await settle();

    expect(passkey).not.toHaveBeenCalled();
    expect(verifies()).toHaveLength(0);
    expect(requests).toContain('POST /api/auth/logout');
    expect(server.session).toBe(false);
    expect(app.account).toBeNull();
    expect(kv.has('bht.account')).toBe(false);
  });

  test('sign-out during the passkey prompt: the prompt is aborted, no verify', async () => {
    const credential = held();
    const { app, server, prompts } = await expiredWithLogin({ credential: credential.response });
    const login = app.signIn((account, signal) => account.login(signal));
    await vi.waitFor(() => expect(prompts).toHaveLength(1));

    const out = app.signOut();
    expect(prompts[0]!.aborted).toBe(true);
    // A browser that hands back a credential anyway is still not verified.
    credential.release(json({ id: 'late' }));
    await Promise.all([login, out]);
    await settle();

    expect(verifies()).toHaveLength(0);
    expect(server.session).toBe(false);
    expect(app.account).toBeNull();
  });

  test('sign-out with verify in flight logs out after it, so its session is revoked', async () => {
    const verify = held();
    const { app, server } = await expiredWithLogin({ verify: verify.response });
    const login = app.signIn((account, signal) => account.login(signal));
    await vi.waitFor(() => expect(verifies()).toHaveLength(1));

    const out = app.signOut();
    await settle();
    expect(requests).not.toContain('POST /api/auth/logout');
    expect(app.transition).toBe('signIn');

    verify.release(json({}));
    await Promise.all([login, out]);
    await settle();

    expect(requests.indexOf('POST /api/auth/logout')).toBeGreaterThan(
      requests.indexOf('POST /api/auth/login/verify'),
    );
    expect(server.session).toBe(false);
    // Not placed: the household load never went out under the revoked session.
    expect(requests.slice(requests.indexOf('POST /api/auth/login/verify'))).not.toContain(
      'GET /api/household',
    );
    expect(app.account).toBeNull();
    expect(kv.has('bht.account')).toBe(false);
    expect(app.syncStatus).toBe('idle');
    expect(app.transition).toBeNull();
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

  test('seeded by loadScenario, then signed in on a real server: zero requests', async () => {
    // The two halves meet (#55, #60): the dev seed's own marker, not a hand-set key.
    vi.stubGlobal('location', new URL('https://bht.example/'));
    const { loadScenario } = await import('../dev/seed.ts');
    const db = await openDatabase();
    await loadScenario(db, localStorage, 'healthy-month', Date.parse('2026-10-29T12:00:00Z'));
    db.close();
    const seededBaby = JSON.parse(kv.get('bht.baby')!) as { householdId: string };
    serve(async () => json(emptyPull()));

    let app = await loadApp();
    await expect(app.signIn((account) => account.login())).rejects.toThrow(SEEDED_REFUSAL);
    expect(requests).toEqual([]);
    const pending = (await app.store.pending(10_000)).length;
    expect(pending).toBeGreaterThan(0);

    // Even with a session already stored (signed in before the marker), sync sends nothing.
    kv.set(
      'bht.account',
      JSON.stringify({ householdId: seededBaby.householdId, memberId: newId() }),
    );
    vi.resetModules();
    app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('offline'));
    expect(app.syncError).toBe(SEEDED_REFUSAL);
    expect(requests).toEqual([]);
    expect(await app.store.pending(10_000)).toHaveLength(pending);
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

describe('Readings waits on the other phones (#5 step 3b)', () => {
  const W = Date.parse('2026-10-29T12:00:00.000Z');
  /** The end of the span from the distant past, or null. */
  const through = (spans: [number, number][]) =>
    spans[0]?.[0] === -Infinity ? spans[0][1] : null;
  const sam = (watermark: number | null) => ({
    deviceId: newId(),
    memberName: 'Sam',
    watermark,
    lastSeenAt: W,
    removedAt: null,
    signedOutAt: null,
  });

  test('after a reload the kept list names the phone, and windows wait until a pull', async () => {
    const home = baby();
    kv.set('bht.baby', JSON.stringify(home));
    kv.set('bht.account', JSON.stringify({ householdId: home.householdId, memberId: newId() }));
    const kept = sam(W - 60_000);
    await (await openDatabase()).put('meta', [kept], `devices:${home.householdId}`);
    const pull = held();
    serve(async (url) => (url.startsWith('/api/sync?') ? pull.response : json({})));
    const app = await loadApp();
    await vi.waitFor(() => expect(app.devices).toEqual([kept]));
    const now = W + 60_000;
    expect(through(app.syncedSpans(now, 0))).toBeNull();
    expect(app.waitingOn(-Infinity, W - 3_600_000, now, 0)).toEqual([kept]);

    // The pull reaches through: the new list and its clock sample are adopted together.
    const fresh = { ...kept, watermark: W };
    pull.release(json({ ...emptyPull(), serverNow: W, devices: [fresh] }));
    await vi.waitFor(() => expect(app.devices).toEqual([fresh]));
    const sample = app.clockSample!;
    expect(sample.serverNow).toBe(W);
    const line = through(app.syncedSpans(sample.tSend, sample.pSend))!;
    expect(line).toBe(W - (W - sample.tSend) - 2_000);
    expect(app.waitingOn(-Infinity, line + 1, sample.tSend, sample.pSend)).toEqual([fresh]);
    expect(app.waitingOn(-Infinity, line, sample.tSend, sample.pSend)).toEqual([]);
  });

  test('signed out, the phone’s own log is the whole log', async () => {
    const home = baby();
    kv.set('bht.baby', JSON.stringify(home));
    kv.set('bht.account', JSON.stringify({ householdId: home.householdId, memberId: newId() }));
    serve(async (url) =>
      url.startsWith('/api/sync?')
        ? json({ ...emptyPull(), serverNow: W, devices: [sam(null)] })
        : json({ ok: true }),
    );
    const app = await loadApp();
    await vi.waitFor(() => expect(app.devices).toHaveLength(1));
    expect(through(app.syncedSpans(W, 0))).toBeNull();
    await app.signOut();
    expect(app.devices).toBeNull();
    expect(app.clockSample).toBeNull();
    expect(app.syncedSpans(W, 0)).toEqual([[-Infinity, Infinity]]);
    expect(app.waitingOn(-Infinity, W, W, 0)).toEqual([]);
  });
});
