import 'fake-indexeddb/auto';
import { newId } from '@bht/schema';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openDatabase } from './db.ts';
import { EventStore } from './store.ts';
import { SyncClient } from './sync.ts';
import { FakeServer, FakeTransport } from './testing/fake-server.ts';

const babyId = newId();
const clients: SyncClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

async function phone(server: FakeServer, opts: { pullLimit?: number } = {}) {
  const store = new EventStore(await openDatabase(`test-${newId()}`), newId());
  const transport = new FakeTransport(server);
  const rejected: unknown[] = [];
  // A huge base delay keeps scheduled retries from firing during a test; tests call sync().
  const sync = new SyncClient(store, transport, {
    baseDelayMs: 3_600_000,
    random: () => 1,
    onRejected: (r) => rejected.push(...r),
    ...opts,
  });
  clients.push(sync);
  return { store, transport, sync, rejected };
}

describe('SyncClient', () => {
  test('a log made offline syncs once the network returns', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    mom.transport.online = false;
    const { event } = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    await mom.sync.sync();
    expect(mom.sync.status).toBe('offline');
    expect(await mom.store.events(babyId)).toEqual([event]);
    expect(server.log).toHaveLength(0);

    mom.transport.online = true;
    await mom.sync.sync();
    expect(mom.sync.status).toBe('idle');
    expect(server.current(event.id)).toEqual(event);
    expect(await mom.store.pending(10)).toEqual([]);
  });

  test('two phones see each other’s events', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const dad = await phone(server);
    const feed = await mom.store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 90 });
    const diaper = await dad.store.log(babyId, 'diaper', { kind: 'wet' });
    await mom.sync.sync();
    await dad.sync.sync();
    await mom.sync.sync();
    const ids = (s: EventStore) => s.events(babyId).then((es) => es.map((e) => e.id).sort());
    expect(await ids(mom.store)).toEqual([feed.event.id, diaper.event.id].sort());
    expect(await ids(dad.store)).toEqual(await ids(mom.store));
  });

  test('concurrent offline edits converge on both phones and the server', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const dad = await phone(server);
    const { event } = await mom.store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });
    await mom.sync.sync();
    await dad.sync.sync();

    await mom.store.edit(event.id, { data: { contents: 'formula', volumeMl: 90 } });
    await dad.store.edit(event.id, { data: { contents: 'formula', volumeMl: 120 } });
    await dad.sync.sync(); // dad's v2 reaches the server first and wins
    await mom.sync.sync();
    await dad.sync.sync();

    const winner = server.current(event.id);
    expect(winner?.data).toEqual({ contents: 'formula', volumeMl: 120 });
    expect(await mom.store.current(event.id)).toEqual(winner);
    expect(await dad.store.current(event.id)).toEqual(winner);
    // Mom's losing version is kept, so it can be recovered.
    expect(server.log.filter((v) => v.event.id === event.id)).toHaveLength(3);
  });

  test('a delete on one phone hides the event on the other', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const dad = await phone(server);
    const { event } = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    await mom.sync.sync();
    await dad.sync.sync();
    await dad.store.remove(event.id);
    await dad.sync.sync();
    await mom.sync.sync();
    expect(await mom.store.events(babyId)).toEqual([]);
  });

  test('a retry after a lost response does not duplicate', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    mom.transport.dropNextPushResponse = true;
    await mom.sync.sync();
    expect(mom.sync.status).toBe('offline');
    await mom.sync.sync();
    expect(mom.sync.status).toBe('idle');
    expect(server.log).toHaveLength(1);
    expect(await mom.store.pending(10)).toEqual([]);
    expect(await mom.store.events(babyId)).toHaveLength(1);
  });

  test('a pushed version stays visible when the pull after it fails', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const { event } = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    mom.transport.failPulls = true;
    await mom.sync.sync();
    expect(mom.sync.status).toBe('offline');
    expect(await mom.store.pending(10)).toEqual([]);
    expect(await mom.store.events(babyId)).toEqual([event]);
  });

  test('server-rejected versions are dropped and reported, not retried forever', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const { event } = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    // Simulate a version the server refuses (e.g. a schema change it no longer accepts).
    const realPush = server.push.bind(server);
    server.push = (events) => ({
      results: events.map((e) => {
        const { id, version } = e as { id: string; version: number };
        return { id, version, status: 'rejected' as const, error: 'nope' };
      }),
    });
    await mom.sync.sync();
    server.push = realPush;
    expect(mom.rejected).toEqual([{ id: event.id, version: 1, status: 'rejected', error: 'nope' }]);
    expect(await mom.store.pending(10)).toEqual([]);
    expect(mom.sync.status).toBe('idle');
  });

  test('pulls page through large backlogs', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    for (let i = 0; i < 5; i++) await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    await mom.sync.sync();
    const dad = await phone(server, { pullLimit: 2 });
    await dad.sync.sync();
    expect(await dad.store.events(babyId)).toHaveLength(5);
    expect(await dad.store.cursor()).toBe(5);
  });

  test('401 stops syncing until sign-in', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    mom.transport.status = 401;
    await mom.sync.sync();
    expect(mom.sync.status).toBe('signed_out');
  });

  test('a 401 pauses every trigger until resume()', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    let pulls = 0;
    const pull = mom.transport.pull.bind(mom.transport);
    mom.transport.pull = (...args) => {
      pulls += 1;
      return pull(...args);
    };
    mom.transport.status = 401;
    await mom.sync.sync();
    expect(mom.sync.status).toBe('signed_out');
    pulls = 0;
    const { event } = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    await mom.sync.sync();
    expect(mom.transport.pushes).toBe(0);
    expect(pulls).toBe(0);

    mom.transport.status = null;
    await mom.sync.resume();
    expect(mom.sync.status).toBe('idle');
    expect(server.current(event.id)).toEqual(event);
  });

  test('stopping during a failing request schedules no retry or follow-up run', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    try {
      const server = new FakeServer();
      // A 1 ms base delay: a retry, if scheduled, would fire well inside the wait below.
      const mom = await phone(server);
      const sync = new SyncClient(mom.store, mom.transport, { baseDelayMs: 1, random: () => 1 });
      clients.push(sync);
      let pulls = 0;
      const fail = Promise.withResolvers<never>();
      const started = Promise.withResolvers<void>();
      mom.transport.pull = () => {
        pulls += 1;
        started.resolve();
        return pulls === 1 ? fail.promise : Promise.reject(new TypeError('Failed to fetch'));
      };
      const dispose = sync.start();
      await started.promise;
      const running = sync.sync(); // queues a follow-up run
      dispose();
      fail.reject(new TypeError('Failed to fetch'));
      await running;
      await new Promise((r) => setTimeout(r, 50));
      expect(pulls).toBe(1);
      expect(sync.status).toBe('offline');
      await sync.sync();
      expect(pulls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('concurrent requests are single-flight with one follow-up run', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    await Promise.all([mom.sync.sync(), mom.sync.sync(), mom.sync.sync()]);
    // Let the follow-up run finish.
    await new Promise((r) => setTimeout(r, 50));
    expect(mom.transport.pushes).toBe(1);
    expect(server.log).toHaveLength(1);
  });

  test('backoff doubles from the base, caps, and jitters between 50% and 100%', async () => {
    const store = new EventStore(await openDatabase(`test-${newId()}`), newId());
    const at = (random: number) =>
      new SyncClient(store, new FakeTransport(new FakeServer()), {
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        random: () => random,
      });
    expect([1, 2, 3, 4].map((n) => at(1).backoffMs(n))).toEqual([1000, 2000, 4000, 8000]);
    expect(at(1).backoffMs(20)).toBe(60_000);
    expect(at(0).backoffMs(3)).toBe(2000);
  });
});
