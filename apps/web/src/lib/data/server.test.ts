import 'fake-indexeddb/auto';
import { newId, SCHEMA_VERSION, type BabyEvent } from '@bht/schema';
import { afterEach, describe, expect, test } from 'vitest';
// The real server (#5), in process: the client is tested against it, not only the fake.
import { createApp } from '../../../../server/src/app.ts';
import { ensureHousehold, openDatabase as openServerDb } from '../../../../server/src/db.ts';
import { openDatabase } from './db.ts';
import { HttpError, type SyncTransport } from './protocol.ts';
import { EventStore } from './store.ts';
import { SyncClient } from './sync.ts';

const babyId = newId();
const clients: SyncClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

function realServer() {
  const db = openServerDb(':memory:');
  const household = newId();
  ensureHousehold(db, household);
  return createApp(db, { session: () => ({ householdId: household }) });
}

/** httpTransport's requests, sent to the in-process app instead of the network. */
function transportTo(app: ReturnType<typeof createApp>, schemaVersion = SCHEMA_VERSION) {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await app.request(path, init);
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as T;
  };
  return {
    push: (events: BabyEvent[]) =>
      call('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion, events }),
      }),
    pull: (after: number, limit: number, through?: number) =>
      call(
        `/api/sync?after=${after}&limit=${limit}` +
          (through === undefined ? '' : `&through=${through}`),
      ),
  } satisfies SyncTransport;
}

async function phone(transport: SyncTransport) {
  const store = new EventStore(await openDatabase(`test-${newId()}`), newId());
  const sync = new SyncClient(store, transport, { baseDelayMs: 3_600_000, random: () => 1 });
  clients.push(sync);
  return { store, sync };
}

describe('SyncClient against the real server', () => {
  test('two phones converge on concurrent edits and a delete', async () => {
    const app = realServer();
    const mom = await phone(transportTo(app));
    const dad = await phone(transportTo(app));
    const feed = await mom.store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });
    const wet = await dad.store.log(babyId, 'diaper', { kind: 'wet' });
    await mom.sync.sync();
    await dad.sync.sync();
    await mom.sync.sync();
    // Both edit the feed offline, then dad deletes the diaper.
    await mom.store.edit(feed.event.id, { data: { contents: 'formula', volumeMl: 90 } });
    await dad.store.edit(feed.event.id, { data: { contents: 'breast_milk', volumeMl: 60 } });
    await dad.store.remove(wet.event.id);
    await mom.sync.sync();
    await dad.sync.sync();
    await mom.sync.sync();
    const momView = await mom.store.events(babyId);
    expect(momView).toEqual(await dad.store.events(babyId));
    expect(momView.map((e) => e.id)).toEqual([feed.event.id]);
    // Mom's version 2 reached the server first, so it wins on both phones.
    expect(momView[0]!.data).toEqual({ contents: 'formula', volumeMl: 90 });
    expect(await mom.store.pending(10)).toEqual([]);
    expect(await dad.store.pending(10)).toEqual([]);
  });

  test('a newer app than the server keeps its writes pending, then syncs after the upgrade', async () => {
    const app = realServer();
    const ahead = await phone(transportTo(app, SCHEMA_VERSION + 1));
    const { event } = await ahead.store.log(babyId, 'diaper', { kind: 'wet' });
    await ahead.sync.sync();
    expect(ahead.sync.status).toBe('offline');
    expect(await ahead.store.pending(10)).toEqual([event]);
    expect(await ahead.store.rejectedCount()).toBe(0);

    // The same phone once the server runs the app's schema: everything it held goes up.
    const after = new SyncClient(ahead.store, transportTo(app), { baseDelayMs: 3_600_000 });
    clients.push(after);
    await after.sync();
    expect(await ahead.store.pending(10)).toEqual([]);
    const other = await phone(transportTo(app));
    await other.sync.sync();
    expect(await other.store.events(babyId)).toEqual([event]);
  });
});
