import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { idTime, newId, type SignedIn } from '@bht/schema';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openDatabase } from '../data/db.ts';
import { EventStore } from '../data/store.ts';

// The whole phone's side of a clear (#85): the real AppState over a real EventStore, with fetch
// answered by each test. Same harness as app.test.ts.

const CLEARED = 'This household’s data was cleared';
const baby = (householdId = newId(), name = 'Fixture') => ({
  id: newId(),
  householdId,
  name,
  birthAt: '2026-10-01T00:00:00.000Z',
  sex: 'female' as const,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const emptyPull = (clearId: string | null = null, next = 0) => ({
  versions: [],
  next,
  through: next,
  more: false,
  serverNow: Date.now(),
  devices: [],
  clearId,
});
const refusal = (cleared: string | null) => json({ error: CLEARED, cleared }, 409);
const settle = () => new Promise((r) => setTimeout(r, 50));

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let kv: Map<string, string>;
let requests: { method: string; url: string; body: unknown }[];

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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function serve(handler: Fetch) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method: init?.method ?? 'GET', url, body });
      return handler(url, init);
    }),
  );
}

const pushes = () => requests.filter((r) => r.method === 'POST' && r.url === '/api/sync');
const pulls = () => requests.filter((r) => r.method === 'GET' && r.url.startsWith('/api/sync?'));
const bodyOf = (init?: RequestInit) =>
  (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as { clearId?: string | null };
const markerIn = (url: string) => new URL(url, 'http://localhost').searchParams.get('clearId');

async function loadApp() {
  const { app } = await import('./app.svelte.ts');
  await app.init();
  return app;
}

/** A signed-in phone with its baby, a setup time and one entry that has not synced. */
async function signedInPhone(own = baby()) {
  kv.set('bht.baby', JSON.stringify(own));
  kv.set('bht.setupAt', String(Date.parse('2026-10-02T00:00:00.000Z')));
  kv.set('bht.account', JSON.stringify({ householdId: own.householdId, memberId: newId() }));
  kv.set(`bht.late.${own.householdId}`, '[]');
  const store = new EventStore(await openDatabase(), newId());
  await store.adoptClear(own.householdId, null);
  const entry = await store.log(own.id, 'diaper', { kind: 'wet' });
  return { own, entry: entry.event };
}

/**
 * A server whose household was cleared under `clearId`; every sync request is checked. The
 * baby add is let through whatever it carries, so the refusal lands on the push itself.
 */
function clearedServer(clearId: string, own: ReturnType<typeof baby>) {
  serve(async (url, init) => {
    const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
    if (url === '/api/babies' && init?.method === 'POST') {
      return json({ ...bodyOf(init), householdId: own.householdId });
    }
    if (url.startsWith('/api/sync')) {
      if (sent !== clearId) return refusal(clearId);
      if (init?.method === 'POST') {
        const events =
          (bodyOf(init) as { events?: { id: string; version: number }[] }).events ?? [];
        return url === '/api/sync'
          ? json({
              results: events.map((e, i) => ({ ...e, seq: i + 1, status: 'accepted' })),
              serverNow: Date.now(),
            })
          : json({ watermark: Date.now(), serverNow: Date.now() });
      }
      return json(emptyPull(clearId));
    }
    return json({});
  });
}

describe('a 409 {cleared} from the server', () => {
  test('on push: the phone drops its data and baby, never sends the entry again, and syncs on under the marker', async () => {
    const { own, entry } = await signedInPhone();
    const clearId = newId();
    clearedServer(clearId, own);
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    await settle();

    // One push, refused; nothing of the old data went up again.
    expect(pushes()).toHaveLength(1);
    expect((pushes()[0]!.body as { events: { id: string }[] }).events.map((e) => e.id)).toEqual([
      entry.id,
    ]);
    expect(await app.store.db.getAll('versions')).toEqual([]);
    expect(await app.store.clearMark(own.householdId)).toEqual({ clearId });
    // The baby, its setup time and the late notes are gone; prefs, author and account stay.
    expect(app.baby).toBeNull();
    expect(app.setupAt).toBeNull();
    expect(app.events).toEqual([]);
    expect(kv.has('bht.baby')).toBe(false);
    expect(kv.has('bht.setupAt')).toBe(false);
    expect(app.late).toEqual([]);
    expect(kv.get('bht.cleared')).toBe(clearId);
    expect(app.account?.householdId).toBe(own.householdId);
    expect(kv.has('bht.author')).toBe(true);
    // The notice carries the clear's time, from the marker itself.
    expect(app.clearNotice).toEqual({ clearId, at: idTime(clearId) });
    // Later requests carry the marker.
    expect(pulls().map((p) => markerIn(p.url))).toContain(clearId);

    // The next baby starts clean: a fresh setup time, so Readings count from here.
    const before = Date.now();
    app.setBaby(baby(own.householdId, 'Next'));
    expect(app.setupAt).toBeGreaterThanOrEqual(before);
    expect(app.baby?.name).toBe('Next');
    app.dismissClearNotice();
    expect(app.clearNotice).toBeNull();
    expect(kv.has('bht.clearNotice')).toBe(false);
  });

  test('on the baby add before a push: the same, with nothing pushed at all', async () => {
    const { own } = await signedInPhone();
    const clearId = newId();
    serve(async (url) => {
      if (url === '/api/babies') return refusal(clearId);
      if (url.startsWith('/api/sync?')) {
        return markerIn(url) === clearId ? json(emptyPull(clearId)) : refusal(clearId);
      }
      return json({});
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(pushes()).toHaveLength(0);
    expect(app.baby).toBeNull();
    expect(await app.store.clearMark(own.householdId)).toEqual({ clearId });
  });
});

describe('Settings → Clear all data', () => {
  test('a failed request deletes nothing; the server’s answer clears this phone and the next sync carries the marker', async () => {
    const { own, entry } = await signedInPhone();
    let server: 'down' | 'up' = 'down';
    const clearId = newId();
    let cleared = false;
    serve(async (url, init) => {
      if (url === '/api/household/clear') {
        if (server === 'down') throw new TypeError('Failed to fetch');
        expect(bodyOf(init).clearId).toBeNull();
        cleared = true;
        return json({ clearId, clearedAt: new Date().toISOString() });
      }
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if (cleared && sent !== clearId) return refusal(clearId);
      if (url === '/api/babies') return json(own);
      if (url === '/api/sync') {
        return json({
          results: [{ id: entry.id, version: 1, seq: 1, status: 'accepted' }],
          serverNow: Date.now(),
        });
      }
      if (url.startsWith('/api/sync?')) return json(emptyPull(cleared ? clearId : null, 1));
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(await app.store.events(own.id)).toHaveLength(1);

    await expect(app.clearData()).rejects.toThrow(TypeError);
    expect(app.baby).toEqual(own);
    expect(await app.store.events(own.id)).toHaveLength(1);
    expect(kv.has('bht.baby')).toBe(true);

    server = 'up';
    await app.clearData();
    expect(app.baby).toBeNull();
    expect(await app.store.db.getAll('versions')).toEqual([]);
    expect(await app.store.clearMark(own.householdId)).toEqual({ clearId });
    expect(app.clearNotice?.clearId).toBe(clearId);
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(markerIn(pulls().at(-1)!.url)).toBe(clearId);
  });

  test('when the other phone cleared first, the server’s 409 clears this phone instead', async () => {
    const { own } = await signedInPhone();
    const clearId = newId();
    let seen = false;
    serve(async (url, init) => {
      if (url === '/api/household/clear') return refusal(clearId);
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if (url.startsWith('/api/sync') && sent !== clearId) {
        // Before the clear runs, the phone is held at its first push.
        if (!seen) return new Promise<Response>(() => {});
        return refusal(clearId);
      }
      if (url === '/api/babies') return json(own);
      if (url.startsWith('/api/sync?')) return json(emptyPull(clearId));
      return json({});
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    seen = true;
    await app.clearData();
    expect(app.baby).toBeNull();
    expect(await app.store.clearMark(own.householdId)).toEqual({ clearId });
  });
});

describe('at startup', () => {
  test('a clear that died between its IndexedDB and localStorage steps is finished', async () => {
    const own = baby();
    const clearId = newId();
    kv.set('bht.baby', JSON.stringify(own));
    kv.set('bht.setupAt', '1700000000000');
    kv.set('bht.account', JSON.stringify({ householdId: own.householdId, memberId: newId() }));
    // The IndexedDB side committed: no rows, the marker recorded. The localStorage side did not.
    await (await openDatabase()).put('meta', { clearId }, `clear:${own.householdId}`);
    serve(async (url) => (url.startsWith('/api/sync?') ? json(emptyPull(clearId)) : json({})));
    const app = await loadApp();
    expect(app.baby).toBeNull();
    expect(app.setupAt).toBeNull();
    expect(kv.has('bht.baby')).toBe(false);
    expect(kv.get('bht.cleared')).toBe(clearId);
    expect(app.clearNotice?.clearId).toBe(clearId);
  });

  test('a phone whose localStorage side is done is left alone', async () => {
    const own = baby();
    const clearId = newId();
    kv.set('bht.baby', JSON.stringify(own));
    kv.set('bht.account', JSON.stringify({ householdId: own.householdId, memberId: newId() }));
    kv.set('bht.cleared', clearId);
    await (await openDatabase()).put('meta', { clearId }, `clear:${own.householdId}`);
    serve(async (url) => (url.startsWith('/api/sync?') ? json(emptyPull(clearId)) : json({})));
    const app = await loadApp();
    expect(app.baby).toEqual(own);
  });
});

describe('placement after a clear', () => {
  const householdOf = (hh: string, babies: unknown[], clearId: string | null) =>
    json({ id: hh, members: [], babies, clearId });

  test('a phone with its own baby and logs joins an already-cleared household: nothing dropped, and it gets the choice', async () => {
    const own = baby(newId(), 'Mine');
    kv.set('bht.baby', JSON.stringify(own));
    kv.set('bht.setupAt', '1700000000000');
    const store = new EventStore(await openDatabase(), newId());
    const mine = await store.log(own.id, 'diaper', { kind: 'wet' });
    const hh = newId();
    const theirs = baby(hh, 'Theirs');
    const clearId = newId();
    serve(async (url, init) => {
      if (url === '/api/household') return householdOf(hh, [theirs], clearId);
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if (url.startsWith('/api/sync') && sent !== clearId) return refusal(clearId);
      if (url === '/api/sync') {
        const { events } = bodyOf(init) as unknown as { events: { id: string; version: number }[] };
        return json({
          results: events.map((e, i) => ({ ...e, seq: i + 1, status: 'accepted' })),
          serverNow: Date.now(),
        });
      }
      if (url.startsWith('/api/sync?')) return json(emptyPull(clearId));
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    const app = await loadApp();
    await app.signIn(async () => ({ householdId: hh, memberId: newId() }) as SignedIn);

    // JoinChoice is up, with everything still here.
    expect(app.joining).toEqual(theirs);
    expect(app.baby).toEqual(own);
    expect(await app.store.events(own.id)).toEqual([mine.event]);
    expect(app.setupAt).toBe(1700000000000);
    expect(await app.store.clearMark(hh)).toEqual({ clearId });
    expect(kv.get('bht.cleared')).toBe(clearId);
    expect(app.clearNotice).toBeNull();
    expect(pushes()).toHaveLength(0);

    // Moving them in uploads them under the household's marker.
    await app.settleJoin(true);
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(app.baby).toEqual(theirs);
    expect(pushes()).toHaveLength(1);
    expect((pushes()[0]!.body as { clearId: string }).clearId).toBe(clearId);
    expect((await app.store.events(theirs.id)).map((e) => e.id)).toEqual([mine.event.id]);
  });

  test('a phone joining a cleared household that has no baby yet keeps its own', async () => {
    const own = baby(newId(), 'Mine');
    kv.set('bht.baby', JSON.stringify(own));
    const store = new EventStore(await openDatabase(), newId());
    await store.log(own.id, 'diaper', { kind: 'wet' });
    const hh = newId();
    const clearId = newId();
    serve(async (url, init) => {
      if (url === '/api/household') return householdOf(hh, [], clearId);
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if (url.startsWith('/api/sync') && sent !== clearId) return refusal(clearId);
      if (url === '/api/babies') return json({ ...own, householdId: hh });
      if (url === '/api/sync') {
        const { events } = bodyOf(init) as unknown as { events: { id: string; version: number }[] };
        return json({
          results: events.map((e, i) => ({ ...e, seq: i + 1, status: 'accepted' })),
          serverNow: Date.now(),
        });
      }
      if (url.startsWith('/api/sync?')) return json(emptyPull(clearId));
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    const app = await loadApp();
    await app.signIn(async () => ({ householdId: hh, memberId: newId() }) as SignedIn);
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(app.baby).toEqual(own);
    expect(app.joining).toBeNull();
    expect(await app.store.events(own.id)).toHaveLength(1);
    expect(requests.find((r) => r.url === '/api/babies')?.body).toMatchObject({ clearId });
    expect((pushes()[0]!.body as { clearId: string }).clearId).toBe(clearId);
  });

  test('a phone that belonged before the clear drops its copy at sign-in: a held marker, or a device list from before #85', async () => {
    for (const legacy of [false, true]) {
      kv = new Map();
      requests = [];
      vi.stubGlobal('indexedDB', new IDBFactory());
      const hh = newId();
      const own = baby(hh);
      kv.set('bht.baby', JSON.stringify(own));
      kv.set('bht.setupAt', '1700000000000');
      const store = new EventStore(await openDatabase(), newId());
      await store.log(own.id, 'diaper', { kind: 'wet' });
      if (legacy) await store.db.put('meta', [], `devices:${hh}`);
      else await store.adoptClear(hh, null);
      const clearId = newId();
      const next = baby(hh, 'Next');
      serve(async (url) => {
        if (url === '/api/household') return householdOf(hh, [next], clearId);
        if (url.startsWith('/api/sync?')) {
          return markerIn(url) === clearId ? json(emptyPull(clearId)) : refusal(clearId);
        }
        return json({ watermark: Date.now(), serverNow: Date.now() });
      });
      const app = await loadApp();
      await app.signIn(async () => ({ householdId: hh, memberId: newId() }) as SignedIn);
      await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
      // Dropped, then placed on the household's new baby; nothing of the old log went up.
      expect(await app.store.db.getAll('versions')).toEqual([]);
      expect(app.baby).toEqual(next);
      expect(app.joining).toBeNull();
      expect(app.clearNotice?.clearId).toBe(clearId);
      expect(pushes()).toHaveLength(0);
      expect(await app.store.clearMark(hh)).toEqual({ clearId });
      vi.resetModules();
    }
  });

  test('a restored server (marker back to null) also makes a phone holding a marker drop its copy', async () => {
    const hh = newId();
    const own = baby(hh);
    kv.set('bht.baby', JSON.stringify(own));
    kv.set('bht.account', JSON.stringify({ householdId: hh, memberId: newId() }));
    const store = new EventStore(await openDatabase(), newId());
    await store.adoptClear(hh, newId());
    const after = await store.log(own.id, 'diaper', { kind: 'wet' });
    serve(async (url, init) => {
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if (url.startsWith('/api/sync') && sent !== null) return refusal(null);
      if (url === '/api/babies') return json(own);
      if (url.startsWith('/api/sync?')) return json(emptyPull(null));
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    // The push carried the newer marker and was refused: the entry never reached the restored log.
    expect(pushes()).toHaveLength(1);
    expect((pushes()[0]!.body as { events: { id: string }[] }).events[0]!.id).toBe(after.event.id);
    expect(await app.store.db.getAll('versions')).toEqual([]);
    expect(await app.store.clearMark(hh)).toEqual({ clearId: null });
    expect(app.baby).toBeNull();
    expect(app.clearNotice?.clearId).toBeNull();
  });
});
