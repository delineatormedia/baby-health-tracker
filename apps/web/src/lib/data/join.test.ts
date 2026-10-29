import 'fake-indexeddb/auto';
import { newId } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { openDatabase, rowKey } from './db.ts';
import { EventStore } from './store.ts';
import { SyncClient } from './sync.ts';
import { FakeServer, FakeTransport } from './testing/fake-server.ts';

// Joining a household from a phone that already has its own baby (sync plan step 2).
const mine = newId();
const household = newId();

async function makeStore(name = `test-${newId()}`, authorId = newId()) {
  let t = Date.parse('2026-10-29T03:00:00.000Z');
  const now = () => new Date((t += 1000));
  return { store: new EventStore(await openDatabase(name), authorId, now), name, authorId };
}

/** Three entries for `mine`: a wet diaper, a bottle edited twice, and a deleted bottle. */
async function seed(store: EventStore) {
  const wet = await store.log(mine, 'diaper', { kind: 'wet' });
  const bottle = await store.log(mine, 'bottle', { contents: 'formula', volumeMl: 60 });
  await store.edit(bottle.event.id, { data: { contents: 'formula', volumeMl: 90 } });
  const edited = await store.edit(bottle.event.id, { notes: 'spat up' });
  const gone = await store.log(mine, 'bottle', { contents: 'breast_milk', volumeMl: 30 });
  await store.remove(gone.event.id);
  return { wet: wet.event, edited: edited.event, gone: gone.event };
}

describe('moveBaby', () => {
  test('moves every entry as its latest version, keeps tombstones, empties the old baby', async () => {
    const { store } = await makeStore();
    const { wet, edited, gone } = await seed(store);
    // The join screen's count: "This phone has 2 entries".
    expect(await store.events(mine)).toHaveLength(2);

    expect(await store.moveBaby(mine, household)).toBe(3);
    expect(await store.events(mine)).toEqual([]);
    const moved = await store.events(household);
    expect(moved.map((e) => e.id).sort()).toEqual([wet.id, edited.id].sort());
    const bottle = moved.find((e) => e.id === edited.id)!;
    expect(bottle).toMatchObject({ version: 4, babyId: household, notes: 'spat up' });
    expect(bottle.data).toEqual({ contents: 'formula', volumeMl: 90 });
    const tomb = await store.current(gone.id);
    expect(tomb).toMatchObject({ deleted: true, babyId: household, version: 3 });

    // Only the new versions go up; the pre-join history stays local.
    const pending = await store.pending(100);
    expect(pending.every((e) => e.babyId === household)).toBe(true);
    expect(pending.map((e) => `${e.id}:${e.version}`).sort()).toEqual(
      [`${wet.id}:2`, `${edited.id}:4`, `${gone.id}:3`].sort(),
    );
    const old = await store.db.getAllFromIndex('versions', 'byBaby', mine);
    expect(old).toHaveLength(6);
    expect(old.every((r) => r.localOnly === 1 && r.pending === 0)).toBe(true);
  });

  test('a reload after the move keeps it, and running it again moves nothing', async () => {
    const { store, name, authorId } = await makeStore();
    await seed(store);
    await store.moveBaby(mine, household);
    store.db.close();
    const { store: again } = await makeStore(name, authorId);
    expect(await again.events(mine)).toEqual([]);
    expect(await again.events(household)).toHaveLength(2);
    const before = await again.db.getAll('versions');
    expect(await again.moveBaby(mine, household)).toBe(0);
    expect(await again.db.getAll('versions')).toEqual(before);
  });

  test('a failure inside the move changes nothing', async () => {
    const { store } = await makeStore();
    await seed(store);
    // A row this schema refuses (from an older app, say), under the newest id so the move
    // fails after writing the others.
    const bad = { ...(await store.events(mine))[0]!, id: newId(), version: 1 };
    const broken = {
      ...bad,
      type: 'bottle' as const,
      data: { contents: 'formula', volumeMl: 1e6 },
    };
    await store.db.add('versions', {
      key: rowKey(broken, null),
      id: broken.id,
      babyId: mine,
      seq: null,
      pending: 1,
      event: broken,
    });
    const before = await store.db.getAll('versions');
    await expect(store.moveBaby(mine, household)).rejects.toThrow(/Cannot move/);
    expect(await store.db.getAll('versions')).toEqual(before);
    expect(await store.events(household)).toEqual([]);
  });
});

describe('archiveBaby', () => {
  test('keeps every entry on the phone, read under the old baby, and uploads none', async () => {
    const { store, name, authorId } = await makeStore();
    await seed(store);
    const shown = await store.events(mine);
    await store.archiveBaby(mine);
    expect(await store.pending(100)).toEqual([]);
    expect(await store.events(mine)).toEqual(shown);
    const rows = await store.db.getAllFromIndex('versions', 'byBaby', mine);
    expect(rows.every((r) => r.localOnly === 1 && r.archived === 1)).toBe(true);
    store.db.close();
    const { store: again } = await makeStore(name, authorId);
    expect(await again.events(mine)).toEqual(shown);
    expect(await again.pending(100)).toEqual([]);
  });
});

describe('what a joined phone pushes', () => {
  async function pushedBabies(join: (s: EventStore) => Promise<unknown>) {
    const { store } = await makeStore();
    await seed(store);
    await join(store);
    await store.log(household, 'diaper', { kind: 'wet' });
    const transport = new FakeTransport(new FakeServer());
    const sync = new SyncClient(store, transport, { baseDelayMs: 3_600_000 });
    await sync.sync();
    sync.stop();
    return transport.pushed.flat();
  }

  test('after a move, never a row of the old baby', async () => {
    const pushed = await pushedBabies((s) => s.moveBaby(mine, household));
    expect(pushed).toHaveLength(4);
    expect(pushed.every((e) => e.babyId === household)).toBe(true);
  });

  test('after an archive, never an archived row', async () => {
    const pushed = await pushedBabies((s) => s.archiveBaby(mine));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.babyId).toBe(household);
  });
});
