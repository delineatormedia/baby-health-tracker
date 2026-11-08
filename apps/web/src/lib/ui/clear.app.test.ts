import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { idTime, newId, type SignedIn } from '@bht/schema';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// The real server (#5), in process, for the #97 probes.
import { createApp } from '../../../../server/src/app.ts';
import {
  ensureDevice,
  ensureHousehold,
  openDatabase as openServerDb,
} from '../../../../server/src/db.ts';
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
afterEach(async () => {
  // Each app's sync client is stopped here, before the globals go: left running, a failed run's
  // backoff retry would land in a later test's request log.
  for (const app of loaded.splice(0)) await app.dispose();
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

/** The apps this test loaded, for afterEach to stop. */
const loaded: { dispose(): Promise<void> }[] = [];

async function loadApp() {
  const { app } = await import('./app.svelte.ts');
  loaded.push(app);
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

    // No answer at all: the phone cannot know whether the clear ran, and says so.
    await expect(app.clearData()).rejects.toMatchObject({
      name: 'ClearFailed',
      outcome: 'unknown',
    });
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

  test('a refusal from the server deleted nothing, and the note says exactly that', async () => {
    const { own, entry } = await signedInPhone();
    serve(async (url) => {
      if (url === '/api/household/clear') return json({ error: 'Not allowed' }, 403);
      if (url === '/api/babies') return json(own);
      if (url === '/api/sync') {
        return json({
          results: [{ id: entry.id, version: 1, seq: 1, status: 'accepted' }],
          serverNow: Date.now(),
        });
      }
      if (url.startsWith('/api/sync?')) return json(emptyPull(null, 1));
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    const app = await loadApp();
    // Settled before the clear: a sync left failing here would retry into the tests that follow.
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    const { clearFailure } = await import('./app.svelte.ts');
    const failure: unknown = await app.clearData().catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'ClearFailed', outcome: 'nothing' });
    expect(clearFailure(failure)).toBe('Nothing was deleted: Not allowed');
    expect(app.baby).toEqual(own);
  });

  test('a clear that ran but whose answer was lost says so; the sync it starts drops the copy', async () => {
    const { own, entry } = await signedInPhone();
    const clearId = newId();
    let cleared = false;
    serve(async (url, init) => {
      if (url === '/api/household/clear') {
        // The server committed the clear; its answer never arrives.
        cleared = true;
        throw new TypeError('Failed to fetch');
      }
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if (cleared && url.startsWith('/api/sync') && sent !== clearId) return refusal(clearId);
      if (url === '/api/household')
        return json({ id: own.householdId, members: [], babies: [], clearId });
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
    const { clearFailure } = await import('./app.svelte.ts');

    const failure: unknown = await app.clearData().catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'ClearFailed', outcome: 'unknown' });
    expect(clearFailure(failure)).toBe(
      'The clear may or may not have run: No connection to the server. Try again. This phone checks with the server on its next sync, and drops its copy if the data was deleted.',
    );
    // The sync it started is refused with the household's marker, and this phone drops its copy.
    await vi.waitFor(() => expect(app.baby).toBeNull());
    expect(await app.store.db.getAll('versions')).toEqual([]);
    expect(await app.store.clearMark(own.householdId)).toEqual({ clearId });
    expect(app.clearNotice?.clearId).toBe(clearId);
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
  });

  test('a copy this phone could not finish dropping is finished by the next sync, before it sends or pulls anything', async () => {
    const { own, entry } = await signedInPhone();
    const clearId = newId();
    let cleared = false;
    serve(async (url) => {
      if (url === '/api/household/clear') {
        cleared = true;
        return json({ clearId, clearedAt: new Date().toISOString() });
      }
      if (url === '/api/babies') return json(own);
      if (url === '/api/household')
        return json({ id: own.householdId, members: [], babies: [], clearId });
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
    const before = requests.length;

    // IndexedDB drops its rows; removing the stored baby fails once.
    const remove = localStorage.removeItem.bind(localStorage);
    let failOnce = true;
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      if (key === 'bht.baby' && failOnce) {
        failOnce = false;
        throw new Error('one transient storage failure');
      }
      remove(key);
    });
    await expect(app.clearData()).rejects.toMatchObject({ name: 'ClearFailed', outcome: 'local' });
    expect(await app.store.db.getAll('versions')).toEqual([]);
    expect(await app.store.clearMark(own.householdId)).toEqual({ clearId });

    // The sync the clear started finishes the localStorage side first: the baby and its setup
    // time are gone, the notice is up, and the pending record is retired.
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(app.baby).toBeNull();
    expect(kv.has('bht.baby')).toBe(false);
    expect(kv.has('bht.setupAt')).toBe(false);
    expect(app.clearNotice?.clearId).toBe(clearId);
    expect(await app.store.pendingWipe(own.householdId)).toBeNull();
    // Nothing went up or came down before the cleanup was done: the erased baby was not added
    // again, and every sync request since the clear carries the new marker.
    const since = requests.slice(before).filter((r) => r.url.startsWith('/api/sync'));
    expect(since.length).toBeGreaterThan(0);
    for (const r of since) {
      const sent = r.url.startsWith('/api/sync?')
        ? markerIn(r.url)
        : ((r.body as { clearId?: string | null })?.clearId ?? null);
      expect(sent).toBe(clearId);
    }
    expect(requests.slice(before).filter((r) => r.url === '/api/babies')).toEqual([]);
  });
});

describe('a clear in another tab while this tab is mid-sync', () => {
  test('a batch read before the clear cannot bring the baby or its entries back under the new marker', async () => {
    const own = baby();
    kv.set('bht.baby', JSON.stringify(own));
    kv.set('bht.setupAt', String(Date.parse('2026-10-02T00:00:00.000Z')));
    kv.set('bht.account', JSON.stringify({ householdId: own.householdId, memberId: newId() }));
    const seed = new EventStore(await openDatabase(), newId());
    await seed.adoptClear(own.householdId, null);
    // The household as the server holds it: its marker, babies and log.
    let marker: string | null = null;
    const babies = new Set([own.id]);
    const log: string[] = [];
    serve(async (url, init) => {
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if (url === '/api/household')
        return json({ id: own.householdId, members: [], babies: [], clearId: marker });
      if (url === '/api/babies' || url.startsWith('/api/sync')) {
        if (sent !== marker) return refusal(marker);
      }
      if (url === '/api/babies') {
        babies.add((bodyOf(init) as { id: string }).id);
        return json({ ...bodyOf(init), householdId: own.householdId });
      }
      if (url === '/api/sync') {
        const events = (bodyOf(init) as { events: { id: string; version: number }[] }).events;
        log.push(...events.map((e) => e.id));
        return json({
          results: events.map((e, i) => ({
            ...e,
            seq: log.length - events.length + i + 1,
            status: 'accepted',
          })),
          serverNow: Date.now(),
        });
      }
      if (url.startsWith('/api/sync?')) return json(emptyPull(marker, log.length));
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));

    // The next run pauses right after reading its batch and marker, as a slow tab would.
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const snapshot = app.store.snapshot.bind(app.store);
    let first = true;
    app.store.snapshot = async (...args) => {
      const read = await snapshot(...args);
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return read;
    };
    const erased = (await app.store.log(own.id, 'diaper', { kind: 'wet' })).event;
    await arrived;
    // The other tab clears the household: the server, then this origin's shared IndexedDB.
    // Its broadcast has not reached this tab when the run resumes.
    marker = newId();
    babies.clear();
    log.length = 0;
    await app.store.clearAll(own.householdId, marker);
    release();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));

    expect([...babies], 'the erased baby must not be added back').toEqual([]);
    expect(log, 'the erased entry must not go up under the new marker').not.toContain(erased.id);
    expect(log).toEqual([]);
    expect(await app.store.db.getAll('versions'), 'nothing comes back to IndexedDB').toEqual([]);
    expect(await app.store.clearMark(own.householdId)).toEqual({ clearId: marker });
    // The pending record the other tab's clear left is finished by this tab's run.
    expect(app.baby).toBeNull();
    expect(kv.has('bht.baby')).toBe(false);
    expect(await app.store.pendingWipe(own.householdId)).toBeNull();
  });
});

describe('at startup', () => {
  test('a clear that died between its IndexedDB and localStorage steps is finished', async () => {
    const own = baby();
    const clearId = newId();
    kv.set('bht.baby', JSON.stringify(own));
    kv.set('bht.setupAt', '1700000000000');
    kv.set('bht.account', JSON.stringify({ householdId: own.householdId, memberId: newId() }));
    // The IndexedDB side committed: no rows, the marker and the pending wipe recorded. The
    // localStorage side did not.
    const store = new EventStore(await openDatabase(), newId());
    await store.clearAll(own.householdId, clearId);
    serve(async (url) => (url.startsWith('/api/sync?') ? json(emptyPull(clearId)) : json({})));
    const app = await loadApp();
    expect(app.baby).toBeNull();
    expect(app.setupAt).toBeNull();
    expect(kv.has('bht.baby')).toBe(false);
    expect(app.clearNotice?.clearId).toBe(clearId);
    expect(await app.store.pendingWipe(own.householdId)).toBeNull();
  });

  test('the same for a server restored to before its first clear: the marker is null, and the wipe still runs', async () => {
    const { own } = await signedInPhone();
    const store = new EventStore(await openDatabase(), newId());
    await store.adoptClear(own.householdId, newId());
    // The IndexedDB side of the wipe to "no clear" committed; the phone died before the rest.
    await store.clearAll(own.householdId, null);
    serve(async (url) => (url.startsWith('/api/sync?') ? json(emptyPull(null)) : json({})));
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    expect(app.baby).toBeNull();
    expect(app.setupAt).toBeNull();
    expect(kv.has('bht.baby')).toBe(false);
    expect(kv.has('bht.setupAt')).toBe(false);
    expect(app.clearNotice?.clearId).toBeNull();
    expect(await app.store.pendingWipe(own.householdId)).toBeNull();
  });

  test('a phone whose wipe finished is left alone, with the baby added since', async () => {
    const next = baby();
    const clearId = newId();
    kv.set('bht.account', JSON.stringify({ householdId: next.householdId, memberId: newId() }));
    const store = new EventStore(await openDatabase(), newId());
    await store.clearAll(next.householdId, clearId);
    await store.wipeDone(next.householdId);
    kv.set('bht.baby', JSON.stringify(next));
    serve(async (url) => (url.startsWith('/api/sync?') ? json(emptyPull(clearId)) : json({})));
    const app = await loadApp();
    expect(app.baby).toEqual(next);
  });

  test('a marker adopted at first placement (null included) is not a wipe', async () => {
    const own = baby();
    kv.set('bht.baby', JSON.stringify(own));
    kv.set('bht.account', JSON.stringify({ householdId: own.householdId, memberId: newId() }));
    const store = new EventStore(await openDatabase(), newId());
    await store.adoptClear(own.householdId, null);
    serve(async (url) => (url.startsWith('/api/sync?') ? json(emptyPull(null)) : json({})));
    const app = await loadApp();
    expect(app.baby).toEqual(own);
    expect(app.clearNotice).toBeNull();
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
    // The restored log: the baby and an entry from before the clear.
    const restored = { ...after.event, id: newId(), version: 1 };
    serve(async (url, init) => {
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if (url.startsWith('/api/sync') && sent !== null) return refusal(null);
      if (url === '/api/household')
        return json({ id: hh, members: [], babies: [own], clearId: null });
      if (url === '/api/babies') return json(own);
      if (url.startsWith('/api/sync?')) {
        return json({ ...emptyPull(null, 1), versions: [{ seq: 1, event: restored }] });
      }
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    // The push carried the newer marker and was refused: the entry never reached the restored log.
    expect(pushes()).toHaveLength(1);
    expect((pushes()[0]!.body as { events: { id: string }[] }).events[0]!.id).toBe(after.event.id);
    expect(await app.store.clearMark(hh)).toEqual({ clearId: null });
    expect(app.clearNotice?.clearId).toBeNull();
    // Then the phone takes the restored baby back and shows the restored log, no sign-in needed.
    await vi.waitFor(() => expect(app.baby).toEqual(own));
    await vi.waitFor(() => expect(app.events).toEqual([restored]));
    expect(await app.store.db.getAll('versions')).toHaveLength(1);
  });
});

describe('the next baby after a clear', () => {
  test('the other phone takes the next baby when its sync drops the copy and finds it in the household', async () => {
    const { own, entry } = await signedInPhone();
    const clearId = newId();
    const next = baby(own.householdId, 'Next baby');
    const nextEvent = { ...entry, id: newId(), babyId: next.id };
    serve(async (url, init) => {
      if (url === '/api/household') {
        return json({ id: own.householdId, members: [], babies: [next], clearId });
      }
      const sent = url.startsWith('/api/sync?') ? markerIn(url) : (bodyOf(init).clearId ?? null);
      if ((url.startsWith('/api/sync') || url === '/api/babies') && sent !== clearId) {
        return refusal(clearId);
      }
      if (url.startsWith('/api/sync?')) {
        return json({ ...emptyPull(clearId, 2), versions: [{ seq: 2, event: nextEvent }] });
      }
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.baby).toEqual(next));
    expect(await app.store.events(next.id)).toEqual([nextEvent]);
    await vi.waitFor(() => expect(app.events).toEqual([nextEvent]));
    expect(JSON.parse(kv.get('bht.baby')!)).toEqual(next);
    expect(app.setupAt).not.toBeNull();
    expect(app.clearNotice?.clearId).toBe(clearId);
    expect(await app.store.events(own.id)).toEqual([]);
  });

  test('a baby added after this phone cleared is taken on its next sync, entries or not (acceptance 11.3)', async () => {
    const hh = newId();
    const clearId = newId();
    kv.set('bht.account', JSON.stringify({ householdId: hh, memberId: newId() }));
    const store = new EventStore(await openDatabase(), newId());
    await store.adoptClear(hh, clearId);
    let babies: unknown[] = [];
    let households = 0;
    serve(async (url) => {
      if (url === '/api/household') {
        households += 1;
        return json({ id: hh, members: [], babies, clearId });
      }
      if (url.startsWith('/api/sync?')) return json(emptyPull(clearId));
      return json({ watermark: Date.now(), serverNow: Date.now() });
    });
    // The sync client's "online" trigger stands in for coming back to the app.
    const triggers = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: () => void) => triggers.set(type, fn),
      removeEventListener() {},
    });
    const app = await loadApp();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    await vi.waitFor(() => expect(households).toBe(1));
    await settle();
    expect(app.baby).toBeNull();

    const next = baby(hh, 'Next baby');
    babies = [next];
    triggers.get('online')!();
    await vi.waitFor(() => expect(app.baby).toEqual(next));
    expect(JSON.parse(kv.get('bht.baby')!)).toEqual(next);
    expect(app.events).toEqual([]);
    // Once it has a baby, the phone stops asking the household on every sync.
    const asked = households;
    triggers.get('online')!();
    await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
    await settle();
    expect(households).toBe(asked);
  });
});

describe('logging while a wipe is pending (#97)', () => {
  // Adversarial's two characterisation probes against the real server, in process: a clear
  // whose localStorage side failed leaves the erased baby on screen until a sync finishes it.
  // An entry logged in that window used to be accepted locally, refused by the server as an
  // unknown baby once repair had removed the profile, and then block ordinary sign-out for
  // good. Now the store refuses it up front, with copy saying why, and repair deletes nothing.

  /** The real server with `own`'s household, this phone registered as one of its devices. */
  function realServer(own: ReturnType<typeof baby>) {
    const db = openServerDb(':memory:');
    const deviceId = newId();
    kv.set('bht.author', deviceId);
    ensureHousehold(db, own.householdId, [own.id]);
    ensureDevice(db, own.householdId, deviceId);
    const server = createApp(db, {
      // Sign-in configured, as in production: the baby add and logout are 503 without it.
      auth: { rpId: 'localhost', origin: 'http://localhost', rpName: 'Test' },
      log: () => {},
      session: () => ({ householdId: own.householdId, memberId: `m-${deviceId}`, deviceId }),
    });
    serve(async (url, init) =>
      server.request(url, {
        ...init,
        headers: {
          ...init?.headers,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
      }),
    );
    const holds = (eventId: string) =>
      db.prepare('SELECT 1 FROM event_versions WHERE event_id = ?').get(eventId) !== undefined;
    return { db, holds };
  }

  test.each(['delayed repair', 'failed repair'])(
    'during a %s, the entry is refused with copy that says why; repair then finishes and ordinary sign-out completes',
    async (scenario) => {
      const { own } = await signedInPhone();
      const { db, holds } = realServer(own);
      const app = await loadApp();
      await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));

      // 'delayed repair': the repairing sync's read of the pending record is held open, so the
      // parent's tap lands while it is in flight. 'failed repair': localStorage fails for the
      // clear and again for the first repair, which backs off; the tap lands before the retry.
      const pendingWipe = app.store.pendingWipe.bind(app.store);
      let release = () => {};
      let reached = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const arrived = new Promise<void>((r) => (reached = r));
      let hold = scenario === 'delayed repair';
      app.store.pendingWipe = async (household) => {
        const wipe = await pendingWipe(household);
        if (wipe && hold) {
          hold = false;
          reached();
          await gate;
        }
        return wipe;
      };
      const remove = localStorage.removeItem.bind(localStorage);
      let failures = scenario === 'failed repair' ? 2 : 1;
      vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
        if (key === 'bht.baby' && failures > 0) {
          failures--;
          throw new Error('transient storage failure');
        }
        remove(key);
      });
      await expect(app.clearData()).rejects.toMatchObject({
        name: 'ClearFailed',
        outcome: 'local',
      });
      expect(app.wipePending).toBe(true);
      if (scenario === 'delayed repair') await arrived;
      else await vi.waitFor(() => expect(app.syncError).toContain('could not finish dropping'));

      // The erased baby is still on screen. Logging for it is refused before anything is saved,
      // and the banner says what happened and what comes next.
      expect(app.baby).toEqual(own);
      const refused = await app.log('diaper', { kind: 'wet' }, 'Wet logged').catch((e) => e);
      // By name: resetModules gives the app its own copy of store.ts.
      expect(refused).toMatchObject({ name: 'WipePending' });
      app.fail(refused);
      expect(app.saveError?.text).toMatch(/^Not saved: the household’s data was cleared/);
      expect(app.toast).toBeNull();
      expect(await app.store.db.getAll('versions')).toEqual([]);

      // Repair finishes: nothing to delete, nothing refused, the baby gone from the screen.
      release();
      await vi.waitFor(() => expect(app.syncStatus).toBe('idle'), { timeout: 4_000 });
      await vi.waitFor(() => expect(app.baby).toBeNull());
      expect(app.wipePending).toBe(false);
      expect(await app.store.pendingWipe(own.householdId)).toBeNull();
      expect(await app.store.rejectedCount()).toBe(0);
      expect(await app.store.db.getAll('versions')).toEqual([]);
      app.saveError = null;

      // A replacement baby logs and syncs as usual.
      const next = baby(own.householdId, 'Replacement');
      app.setBaby(next);
      const entry = await app.log('diaper', { kind: 'wet' }, 'Wet logged');
      await vi.waitFor(() => expect(holds(entry.event.id)).toBe(true));
      await vi.waitFor(() => expect(app.syncStatus).toBe('idle'));
      expect(await app.store.rejectedCount()).toBe(0);

      // After a reload too, ordinary sign-out (barrier and all) completes.
      await app.dispose();
      vi.resetModules();
      const rebooted = await loadApp();
      await vi.waitFor(() => expect(rebooted.syncStatus).toBe('idle'));
      expect(rebooted.wipePending).toBe(false);
      expect(rebooted.baby).toEqual(next);
      await rebooted.signOut();
      expect(rebooted.signOutBlocked).toBeNull();
      expect(rebooted.account).toBeNull();
      db.close();
    },
  );
});
