import 'fake-indexeddb/auto';
import { newId, SCHEMA_VERSION } from '@bht/schema';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openDatabase } from './db.ts';
import { EventStore } from './store.ts';
import { pushBytes, SyncClient, TOO_LARGE, type SyncOptions } from './sync.ts';
import { FakeServer, FakeTransport } from './testing/fake-server.ts';

const babyId = newId();
const clients: SyncClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

async function phone(server: FakeServer, opts: SyncOptions = {}) {
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

  test('server-rejected versions are kept, counted and reported, not retried', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const { event } = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    // Simulate a version the server refuses (a server bug, or a schema it no longer accepts).
    const realPush = server.push.bind(server);
    server.push = (events) => ({
      results: events.map((e) => {
        const { id, version } = e as { id: string; version: number };
        return { id, version, status: 'rejected' as const, error: 'nope' };
      }),
    });
    await mom.sync.sync();
    expect(mom.rejected).toEqual([{ id: event.id, version: 1, status: 'rejected', error: 'nope' }]);
    expect(await mom.store.pending(10)).toEqual([]);
    expect(mom.sync.status).toBe('idle');
    // Still on the phone, and counted for Settings.
    expect(await mom.store.events(babyId)).toEqual([event]);
    expect(await mom.store.rejectedCount()).toBe(1);
    const pushes = mom.transport.pushes;
    await mom.sync.sync();
    expect(mom.transport.pushes).toBe(pushes);

    // A later edit of the same entry is a new version, and it is uploaded.
    server.push = realPush;
    const edit = await mom.store.edit(event.id, { notes: 'after the refusal' });
    await mom.sync.sync();
    expect(server.current(event.id)).toEqual(edit.event);
    expect(await mom.store.pending(10)).toEqual([]);
    // The accepted edit replaces the refusal, so Settings stops counting it. The refused
    // version itself is still on the phone.
    expect(await mom.store.rejectedCount()).toBe(0);
    expect(await mom.store.current(event.id)).toEqual(edit.event);
    expect(
      (await mom.store.db.getAllFromIndex('versions', 'byRejected', 1)).map((r) => r.event),
    ).toEqual([event]);
  });

  test('a 409 from an older server keeps every version pending', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const { event } = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    mom.transport.status = 409;
    await mom.sync.sync();
    expect(mom.sync.status).toBe('offline');
    expect(await mom.store.pending(10)).toEqual([event]);
    expect(await mom.store.rejectedCount()).toBe(0);
    mom.transport.status = null;
    await mom.sync.sync();
    expect(server.current(event.id)).toEqual(event);
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

  test('a pull stops at its first page’s through; a push landing mid-pull waits for the next', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    for (let i = 0; i < 3; i++) await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    await mom.sync.sync();
    const dad = await phone(server, { pullLimit: 1 });
    // Mom's next log reaches the server while dad is between his first and second page.
    const late = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    dad.transport.afterPull = () => {
      dad.transport.afterPull = null;
      server.push([late.event]);
    };
    await dad.sync.sync();
    expect(server.log).toHaveLength(4);
    expect(dad.transport.pulls.map((p) => p.through)).toEqual([undefined, 3, 3]);
    expect(await dad.store.events(babyId)).toHaveLength(3);
    expect(await dad.store.cursor()).toBe(3);

    await dad.sync.sync();
    expect((await dad.store.events(babyId)).map((e) => e.id)).toContain(late.event.id);
    // A new pull starts a new snapshot: no through on its first page.
    expect(dad.transport.pulls.at(-1)).toEqual({ after: 3, limit: 1, through: undefined });
    expect(await dad.store.cursor()).toBe(4);
  });

  test('pushes split by bytes as well as count, and the backlog drains', async () => {
    const server = new FakeServer();
    const mom = await phone(server, { pushByteBudget: 20_000 });
    const notes = '日'.repeat(2000); // 6,000 UTF-8 bytes
    for (let i = 0; i < 9; i++) await mom.store.log(babyId, 'diaper', { kind: 'wet' }, { notes });
    await mom.sync.sync();
    expect(mom.sync.status).toBe('idle');
    expect(mom.transport.pushSizes).toEqual([3, 3, 3]);
    expect(await mom.store.pending(10)).toEqual([]);
    expect(server.log).toHaveLength(9);
    expect(mom.transport.pulls).toHaveLength(1);
  });

  test('pushBytes is the size of the body httpTransport sends', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    await mom.store.log(babyId, 'diaper', { kind: 'wet' }, { notes: 'ünïcødé 日本' });
    await mom.store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 90 });
    const events = await mom.store.pending(10);
    const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, events });
    expect(pushBytes(events)).toBe(new TextEncoder().encode(body).length);
  });

  test('a 413 halves the batch until the backlog drains', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const notes = '日'.repeat(2000);
    for (let i = 0; i < 8; i++) await mom.store.log(babyId, 'diaper', { kind: 'wet' }, { notes });
    // A server cap below the client's budget: only two of these fit in one push.
    mom.transport.maxBytes = 13_000;
    await mom.sync.sync();
    expect(mom.sync.status).toBe('idle');
    expect(mom.transport.pushSizes).toEqual([8, 4, 2, 2, 2, 2]);
    expect(await mom.store.pending(10)).toEqual([]);
    expect(server.log).toHaveLength(8);
    expect(await mom.store.rejectedCount()).toBe(0);
    expect(mom.transport.pulls).toHaveLength(1);
  });

  test('a version too large for any push is kept, refused locally and counted; the rest drain', async () => {
    const server = new FakeServer();
    // A cap that one long-notes entry cannot fit under, standing in for an oversized version.
    const mom = await phone(server, { maxPushBytes: 4_000, pushByteBudget: 3_000 });
    const before = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    const big = await mom.store.log(
      babyId,
      'diaper',
      { kind: 'wet' },
      { notes: '日'.repeat(2000) },
    );
    const after = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    await mom.sync.sync();
    expect(mom.sync.status).toBe('idle');
    expect(server.log.map((v) => v.event.id)).toEqual([before.event.id, after.event.id]);
    expect(mom.rejected).toEqual([
      { id: big.event.id, version: 1, status: 'rejected', error: TOO_LARGE },
    ]);
    expect(await mom.store.pending(10)).toEqual([]);
    expect(await mom.store.rejectedCount()).toBe(1);
    // Still on the phone with its error, and never uploaded.
    expect(await mom.store.current(big.event.id)).toEqual(big.event);
    const [row] = await mom.store.db.getAllFromIndex('versions', 'byRejected', 1);
    expect(row?.rejectedError).toBe(TOO_LARGE);
    const pushes = mom.transport.pushes;
    await mom.sync.sync();
    expect(mom.transport.pushes).toBe(pushes);
    expect(mom.transport.pulls).toHaveLength(2);
  });

  test('a single version over the budget that gets a 413 is refused locally', async () => {
    const server = new FakeServer();
    const mom = await phone(server, { pushByteBudget: 3_000 });
    const big = await mom.store.log(
      babyId,
      'diaper',
      { kind: 'wet' },
      { notes: '日'.repeat(2000) },
    );
    const small = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    mom.transport.maxBytes = 4_000;
    await mom.sync.sync();
    expect(mom.sync.status).toBe('idle');
    expect(server.log.map((v) => v.event.id)).toEqual([small.event.id]);
    expect(mom.rejected).toEqual([
      { id: big.event.id, version: 1, status: 'rejected', error: TOO_LARGE },
    ]);
    expect(await mom.store.rejectedCount()).toBe(1);
  });

  test('a small version that gets a 413 stays pending and backs off', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const { event } = await mom.store.log(babyId, 'diaper', { kind: 'wet' });
    mom.transport.maxBytes = 50; // a misconfigured proxy, not an oversized version
    await mom.sync.sync();
    expect(mom.sync.status).toBe('offline');
    expect(await mom.store.pending(10)).toEqual([event]);
    expect(await mom.store.rejectedCount()).toBe(0);
    mom.transport.maxBytes = null;
    await mom.sync.sync();
    expect(server.current(event.id)).toEqual(event);
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
