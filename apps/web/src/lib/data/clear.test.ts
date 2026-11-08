import 'fake-indexeddb/auto';
import { newId, SCHEMA_VERSION, type BabyEvent, type ClearMarker } from '@bht/schema';
import { afterEach, describe, expect, test } from 'vitest';
// The real server (#5), in process, for the two-phone cases.
import { createApp } from '../../../../server/src/app.ts';
import {
  ensureDevice,
  ensureHousehold,
  openDatabase as openServerDb,
} from '../../../../server/src/db.ts';
import { openDatabase, rowKey } from './db.ts';
import { HttpError, isCleared, type BarrierRequest, type SyncTransport } from './protocol.ts';
import { EventStore, WipePending } from './store.ts';
import { failureReason, SyncClient } from './sync.ts';
import { FakeServer, FakeTransport } from './testing/fake-server.ts';

// The phone side of clearing a household's data (#85): dropping the local copy on the
// server's 409 {cleared}, and never uploading what the server has cleared.

const household = newId();
const babyId = newId();
const clients: SyncClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

async function makeStore(authorId = newId()) {
  let t = Date.parse('2026-10-29T03:00:00.000Z');
  return new EventStore(
    await openDatabase(`test-${newId()}`),
    authorId,
    () => new Date((t += 1000)),
  );
}

function fakePhone(server: FakeServer, store: EventStore) {
  const transport = new FakeTransport(server);
  const sync = new SyncClient(store, transport, {
    baseDelayMs: 3_600_000, // a 1 ms retry would race the test's own sync()
    household,
    random: () => 1,
  });
  clients.push(sync);
  return { store, transport, sync };
}

const rows = async (store: EventStore) => store.db.getAll('versions');

describe('EventStore.clearAll', () => {
  test('drops every row kind, the cursor and the device list, and records the marker, in one transaction', async () => {
    const store = await makeStore();
    const kept = await store.log(babyId, 'diaper', { kind: 'wet' });
    const refused = await store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });
    await store.applyPushResults(
      [kept.event, refused.event],
      [
        { id: kept.event.id, version: 1, seq: 1, status: 'accepted' },
        { id: refused.event.id, version: 1, status: 'rejected', error: 'no' },
      ],
    );
    await store.log(babyId, 'diaper', { kind: 'wet' }); // still pending
    const other = newId();
    await store.log(other, 'diaper', { kind: 'wet' });
    await store.archiveBaby(other); // local-only and archived
    await store.db.put('meta', 7, `cursor:${household}`);
    await store.db.put('meta', [], `devices:${household}`);
    expect(await rows(store)).toHaveLength(4);
    expect(await store.clearMark(household)).toBeNull();

    const clearId = newId();
    await store.clearAll(household, clearId);
    expect(await rows(store)).toEqual([]);
    expect(await store.pending(10)).toEqual([]);
    expect(await store.rejectedCount()).toBe(0);
    expect(await store.cursor(household)).toBe(0);
    expect(await store.devices(household)).toBeNull();
    expect(await store.clearMark(household)).toEqual({ clearId });
    expect(await store.db.get('versions', rowKey(kept.event, 1))).toBeUndefined();

    // Writes are refused until the wipe's localStorage side is recorded done (#97).
    await expect(store.log(babyId, 'diaper', { kind: 'wet' })).rejects.toBeInstanceOf(WipePending);
    await store.wipeDone(household);

    // adoptClear records a marker and touches nothing else.
    const entry = await store.log(babyId, 'diaper', { kind: 'wet' });
    const next = newId();
    await store.adoptClear(household, next);
    expect(await store.clearMark(household)).toEqual({ clearId: next });
    expect(await store.pending(10)).toEqual([entry.event]);
  });
});

describe('a pending wipe stops local writes (#97)', () => {
  test('log, edit, undo and moveBaby are refused while the record stands; wipeDone resumes them and deletes nothing', async () => {
    const store = await makeStore();
    const clearId = newId();
    await store.clearAll(household, clearId);
    // A pull under the new marker lands while the wipe is pending: not a local write.
    const pulled: BabyEvent = {
      id: newId(),
      babyId,
      authorId: newId(),
      occurredAt: '2026-10-29T02:00:00.000Z',
      recordedAt: '2026-10-29T02:00:00.000Z',
      version: 1,
      deleted: false,
      notes: null,
      type: 'diaper',
      data: { kind: 'wet' },
    };
    await store.applyPull(
      { versions: [{ seq: 1, event: pulled }], next: 1, more: false, through: 1 },
      household,
      undefined,
      { clearId },
    );
    expect(await store.events(babyId)).toEqual([pulled]);
    const before = await store.snapshot(household);

    await expect(store.log(babyId, 'diaper', { kind: 'wet' })).rejects.toBeInstanceOf(WipePending);
    await expect(store.edit(pulled.id, { notes: 'x' })).rejects.toBeInstanceOf(WipePending);
    await expect(store.remove(pulled.id)).rejects.toBeInstanceOf(WipePending);
    await expect(store.moveBaby(babyId, newId())).rejects.toBeInstanceOf(WipePending);
    expect(await store.snapshot(household)).toEqual(before);
    expect(await store.pending(10)).toEqual([]);

    // Finishing the wipe touches the record alone: the pulled row stays, and writes resume.
    await store.wipeDone(household);
    expect(await store.pendingWipe(household)).toBeNull();
    expect(await store.events(babyId)).toEqual([pulled]);
    const logged = await store.log(babyId, 'diaper', { kind: 'wet' });
    expect((await store.snapshot(household)).gen).toBe(before.gen + 1);
    expect(await store.pending(10)).toEqual([logged.event]);
  });

  test('another tab: a write that opened before the clear is wiped with the rest, one after is refused', async () => {
    // Two tabs on one IndexedDB. B's write opens before A's clear, so IndexedDB commits it first
    // and the clear drops it; C's opens after and sees the pending record.
    const name = `test-${newId()}`;
    const [a, b] = await Promise.all(
      [0, 1].map(async () => new EventStore(await openDatabase(name), newId())),
    );
    const written = b!.log(babyId, 'diaper', { kind: 'wet' });
    const cleared = a!.clearAll(household, newId());
    const refused = b!.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });
    await written;
    await cleared;
    await expect(refused).rejects.toBeInstanceOf(WipePending);
    expect(await rows(a!)).toEqual([]);
  });

  test('the SyncClient’s own onCleared has no localStorage side to finish, so writes resume at once', async () => {
    const server = new FakeServer();
    const { store, sync } = fakePhone(server, await makeStore());
    await store.log(babyId, 'diaper', { kind: 'wet' });
    await sync.sync();
    const clearId = server.clear();
    await sync.sync();
    expect(await store.clearMark(household)).toEqual({ clearId });
    expect(await rows(store)).toEqual([]);
    expect(await store.pendingWipe(household)).toBeNull();
    await expect(store.log(babyId, 'diaper', { kind: 'wet' })).resolves.toBeDefined();
  });
});

describe('SyncClient on 409 {cleared}', () => {
  test('a cleared refusal drops the copy before anything is written, then the run repeats under the new marker', async () => {
    const server = new FakeServer();
    const { store, transport, sync } = fakePhone(server, await makeStore());
    const synced = await store.log(babyId, 'diaper', { kind: 'wet' });
    await sync.sync();
    expect(server.log.map((v) => v.event)).toEqual([synced.event]);
    expect(await store.clearMark(household)).toEqual({ clearId: null });

    // The other phone clears; this one logs offline meanwhile.
    const clearId = server.clear();
    const unsent = await store.log(babyId, 'diaper', { kind: 'dirty', stool: null });
    await sync.sync();

    expect(sync.status).toBe('idle');
    expect(await rows(store)).toEqual([]);
    expect(await store.clearMark(household)).toEqual({ clearId });
    // The refused push carried the old marker; nothing was pushed under the new one: the entry
    // logged offline is gone, not uploaded.
    expect(transport.pushed.flat().map((e) => e.id)).not.toContain(unsent.event.id);
    expect(server.log).toEqual([]);
    // First sync: push, pull, barrier with none held (the pull adopts null); then the refused push.
    expect(transport.markers.slice(0, 4).every((m) => m == null)).toBe(true);
    expect(transport.markers.slice(4).every((m) => m === clearId)).toBe(true);
    // Pulls from 0 under the new marker, and barriers again.
    expect(transport.pulls.at(-1)).toMatchObject({ after: 0 });
    expect(server.barriers.at(-1)).toMatchObject({ clearId });
  });

  test('a server that keeps refusing the marker it handed out is a failure, not a loop', async () => {
    const server = new FakeServer();
    const { store, transport, sync } = fakePhone(server, await makeStore());
    await store.log(babyId, 'diaper', { kind: 'wet' });
    const clearId = server.clear();
    server.accepts = () => false;
    await sync.sync();
    expect(sync.status).toBe('offline');
    expect(sync.error).toBe(failureReason(new HttpError(409, { error: 'x', cleared: clearId })));
    // Dropped the copy once, for the marker it was given, and stopped there.
    expect(await rows(store)).toEqual([]);
    expect(await store.clearMark(household)).toEqual({ clearId });
    expect(transport.markers.filter((m) => m === clearId)).toHaveLength(1);
  });

  test('the first pull page’s marker is adopted only by a phone that holds none', async () => {
    const server = new FakeServer();
    const held = newId();
    const a = fakePhone(server, await makeStore());
    const b = fakePhone(server, await makeStore());
    await b.store.adoptClear(household, held);
    server.clearId = held;
    await a.sync.sync();
    await b.sync.sync();
    // A held none, was accepted as "null", and adopts... nothing: the server's marker is `held`,
    // so A was refused and dropped its (empty) copy, adopting it that way.
    expect(await a.store.clearMark(household)).toEqual({ clearId: held });
    expect(await b.store.clearMark(household)).toEqual({ clearId: held });

    const c = fakePhone(server, await makeStore());
    server.clearId = null;
    await c.sync.sync();
    expect(await c.store.clearMark(household)).toEqual({ clearId: null });
    expect(c.transport.markers).toEqual([undefined, undefined]);
  });

  test('onCleared replaces the default, and its failure backs off', async () => {
    const server = new FakeServer();
    const store = await makeStore();
    const transport = new FakeTransport(server);
    const seen: string[] = [];
    const sync = new SyncClient(store, transport, {
      household,
      baseDelayMs: 3_600_000, // a 1 ms retry would race the test's own sync()
      onCleared: async (id) => {
        seen.push(id!);
        await store.clearAll(household, id);
      },
    });
    clients.push(sync);
    await store.log(babyId, 'diaper', { kind: 'wet' });
    const clearId = server.clear();
    await sync.sync();
    expect(seen).toEqual([clearId]);
    expect(sync.status).toBe('idle');
  });
});

describe('a response from before a clear in another tab', () => {
  // Every tab shares one IndexedDB. The other tab here is the test itself, acting on the same
  // store while this tab's request is out.
  async function held(transport: FakeTransport, hook: 'afterPull' | 'afterPush') {
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    transport[hook] = async () => {
      reached();
      await gate;
    };
    return { arrived, release };
  }

  test('a delayed pull cannot refill the cleared IndexedDB; the run settles under the new marker', async () => {
    const server = new FakeServer();
    const source = await makeStore();
    const old = (await source.log(babyId, 'diaper', { kind: 'wet' })).event;
    server.push([old]);
    const store = await makeStore();
    await store.adoptClear(household, null);
    const { transport, sync } = fakePhone(server, store);
    const { arrived, release } = await held(transport, 'afterPull');
    const running = sync.sync();
    await arrived;
    // The other tab commits the server clear and wipes the shared store.
    const clearId = server.clear();
    await store.clearAll(household, clearId);
    expect(await rows(store)).toEqual([]);
    release();
    await running;
    expect(sync.status).toBe('idle');
    expect(server.log).toEqual([]);
    expect(await store.clearMark(household)).toEqual({ clearId });
    expect(await rows(store)).toEqual([]);
    // The run went round again under the marker the store holds now.
    expect(transport.markers.at(-1)).toBe(clearId);
    expect(transport.barriersSent.at(-1)?.clearId).toBe(clearId);
  });

  test('a batch read before the clear is sent under the marker it was read with, and refused', async () => {
    const server = new FakeServer();
    const store = await makeStore();
    await store.adoptClear(household, null);
    const { transport, sync } = fakePhone(server, store);
    const erased = (await store.log(babyId, 'diaper', { kind: 'wet' })).event;
    // The run pauses right after reading its batch and marker, as a slow tab would.
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const snapshot = store.snapshot.bind(store);
    let first = true;
    store.snapshot = async (...args) => {
      const read = await snapshot(...args);
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return read;
    };
    const running = sync.sync();
    await arrived;
    // The other tab clears the server, then the shared store, before this tab has sent anything.
    const clearId = server.clear();
    await store.clearAll(household, clearId);
    expect(await rows(store)).toEqual([]);
    release();
    await running;
    expect(sync.status).toBe('idle');
    // The push carried the marker its batch was read under, so the server refused it: the
    // erased entry never went up under the new marker, and nothing came back.
    expect(transport.markers[0]).toBeNull();
    expect(transport.pushed).toEqual([]);
    expect(server.log).toEqual([]);
    expect(server.current(erased.id)).toBeUndefined();
    expect(await rows(store)).toEqual([]);
    expect(await store.clearMark(household)).toEqual({ clearId });
    expect(transport.markers.at(-1)).toBe(clearId);
  });

  test('a delayed push answer cannot store the pushed version as synced', async () => {
    const server = new FakeServer();
    const store = await makeStore();
    await store.adoptClear(household, null);
    const { transport, sync } = fakePhone(server, store);
    await store.log(babyId, 'diaper', { kind: 'wet' });
    const { arrived, release } = await held(transport, 'afterPush');
    const running = sync.sync();
    await arrived;
    // The server took the push; before its answer lands, the other tab clears everything.
    expect(server.log).toHaveLength(1);
    const clearId = server.clear();
    await store.clearAll(household, clearId);
    release();
    await running;
    expect(sync.status).toBe('idle');
    expect(await rows(store)).toEqual([]);
    expect(server.log).toEqual([]);
    expect(await store.clearMark(household)).toEqual({ clearId });
  });

  test('a 409 for the marker the store already holds drops nothing again: the other tab did', async () => {
    const server = new FakeServer();
    const store = await makeStore();
    await store.adoptClear(household, null);
    const transport = new FakeTransport(server);
    let wipes = 0;
    const sync = new SyncClient(store, transport, {
      baseDelayMs: 3_600_000,
      household,
      onCleared: async (id) => {
        wipes += 1;
        await store.clearAll(household, id);
      },
    });
    clients.push(sync);
    await store.log(babyId, 'diaper', { kind: 'wet' });
    await sync.sync();
    expect(server.log).toHaveLength(1);
    // This tab's pull is out under the old marker when the other tab clears the server and
    // wipes the shared store; the server refuses the pull with the marker the store now holds.
    let clearId: string | null = null;
    transport.beforePull = async () => {
      if (clearId) return;
      clearId = server.clear();
      await store.clearAll(household, clearId);
    };
    await sync.sync();
    expect(sync.status).toBe('idle');
    expect(wipes).toBe(0);
    expect(await rows(store)).toEqual([]);
    expect(await store.clearMark(household)).toEqual({ clearId });
    expect(transport.markers.at(-1)).toBe(clearId);
  });
});

describe('two phones against the real server', () => {
  function realServer() {
    const db = openServerDb(':memory:');
    const hh = newId();
    ensureHousehold(db, hh, [babyId]);
    const app = createApp(db, {
      log: () => {},
      session: (c) => {
        const deviceId = c.req.header('x-test-device');
        if (!deviceId) return null;
        ensureDevice(db, hh, deviceId);
        return { householdId: hh, memberId: `m-${deviceId}`, deviceId };
      },
    });
    const versions = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM event_versions').get() as { n: number }).n;
    const babies = () => (db.prepare('SELECT COUNT(*) AS n FROM babies').get() as { n: number }).n;
    const holds = (eventId: string) =>
      db.prepare('SELECT 1 FROM event_versions WHERE event_id = ?').get(eventId) !== undefined;
    return { app, db, hh, versions, babies, holds };
  }

  /** httpTransport's requests from one phone, with a switch for airplane mode. */
  function phoneTransport(app: ReturnType<typeof createApp>, deviceId: string) {
    const t: SyncTransport & {
      online: boolean;
      deviceId: string;
      call<T>(path: string, init?: RequestInit): Promise<T>;
      clear(clearId: string | null): Promise<{ clearId: string }>;
    } = {
      online: true,
      deviceId,
      async call<T>(path: string, init: RequestInit = {}): Promise<T> {
        if (!t.online) throw new TypeError('Failed to fetch');
        const headers = new Headers(init.headers);
        headers.set('x-test-device', deviceId);
        headers.set('origin', 'http://localhost');
        const res = await app.request(path, { ...init, headers });
        if (!res.ok) throw new HttpError(res.status, await res.json().catch(() => null));
        return (await res.json()) as T;
      },
      push: (events: BabyEvent[], clearId?: ClearMarker) =>
        t.call('/api/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            events,
            ...(clearId && { clearId }),
          }),
        }),
      pull: (after: number, limit: number, through?: number, clearId?: ClearMarker) =>
        t.call(
          `/api/sync?after=${after}&limit=${limit}` +
            (through === undefined ? '' : `&through=${through}`) +
            (clearId ? `&clearId=${clearId}` : ''),
        ),
      barrier: (req: BarrierRequest) =>
        t.call('/api/sync/barrier', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        }),
      clear: (clearId: string | null) =>
        t.call<{ clearId: string }>('/api/household/clear', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clearId }),
        }),
    };
    return t;
  }

  async function realPhone(app: ReturnType<typeof createApp>, hh: string) {
    const deviceId = newId();
    const store = new EventStore(await openDatabase(`test-${newId()}`), deviceId);
    const transport = phoneTransport(app, deviceId);
    const sync = new SyncClient(store, transport, {
      household: hh,
      baseDelayMs: 3_600_000, // a 1 ms retry would race the test's own sync()
    });
    clients.push(sync);
    return { store, transport, sync };
  }

  /** What the app does when the parent confirms: the server first, then this phone's copy. */
  async function clearFrom(phone: Awaited<ReturnType<typeof realPhone>>, hh: string) {
    const held = (await phone.store.clearMark(hh))?.clearId ?? null;
    const { clearId } = await phone.transport.clear(held);
    await phone.store.clearAll(hh, clearId);
    return clearId;
  }

  test('online: B drops the data on its next sync, and the server holds nothing', async () => {
    const s = realServer();
    const a = await realPhone(s.app, s.hh);
    const b = await realPhone(s.app, s.hh);
    await a.store.log(babyId, 'diaper', { kind: 'wet' });
    await b.store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 90 });
    await a.sync.sync();
    await b.sync.sync();
    await a.sync.sync();
    expect(await a.store.events(babyId)).toHaveLength(2);
    expect(await b.store.events(babyId)).toHaveLength(2);
    expect(s.versions()).toBe(2);

    const clearId = await clearFrom(a, s.hh);
    expect(s.versions()).toBe(0);
    expect(s.babies()).toBe(0);
    expect(await a.store.events(babyId)).toEqual([]);

    await b.sync.sync();
    expect(b.sync.status).toBe('idle');
    expect(await b.store.events(babyId)).toEqual([]);
    expect(await rows(b.store)).toEqual([]);
    expect(await b.store.clearMark(s.hh)).toEqual({ clearId });
    expect(s.versions()).toBe(0);
    // A post-clear sync from either phone restores nothing.
    await a.sync.sync();
    await b.sync.sync();
    expect(s.versions()).toBe(0);
    expect(await rows(a.store)).toEqual([]);
  });

  test('offline: B’s entry logged while away is never stored; B comes back empty', async () => {
    const s = realServer();
    const a = await realPhone(s.app, s.hh);
    const b = await realPhone(s.app, s.hh);
    await a.store.log(babyId, 'diaper', { kind: 'wet' });
    await a.sync.sync();
    await b.sync.sync();
    expect(await b.store.events(babyId)).toHaveLength(1);

    b.transport.online = false;
    const away = await b.store.log(babyId, 'diaper', { kind: 'dirty', stool: null });
    await b.sync.sync();
    expect(b.sync.status).toBe('offline');
    expect(await b.store.pending(10)).toEqual([away.event]);

    const clearId = await clearFrom(a, s.hh);
    expect(s.versions()).toBe(0);

    b.transport.online = true;
    await b.sync.sync();
    expect(b.sync.status).toBe('idle');
    expect(await rows(b.store)).toEqual([]);
    expect(await b.store.clearMark(s.hh)).toEqual({ clearId });
    expect(s.versions()).toBe(0);
    expect(s.holds(away.event.id)).toBe(false);
  });

  test('the clear itself is refused for a phone that missed the last one; isCleared reads the body', async () => {
    const s = realServer();
    const a = await realPhone(s.app, s.hh);
    const b = await realPhone(s.app, s.hh);
    await a.sync.sync();
    await b.sync.sync();
    const first = await clearFrom(a, s.hh);
    // B still holds null and tries to clear too.
    const refusal = await b.transport.clear(null).catch((e: unknown) => e);
    expect(isCleared(refusal)).toBe(true);
    expect((refusal as HttpError).cleared).toBe(first);
  });
});
