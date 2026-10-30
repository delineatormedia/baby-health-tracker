import 'fake-indexeddb/auto';
import { newId } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { openDatabase, rowKey } from './db.ts';
import { EventStore, SigningOut } from './store.ts';
import { FakeServer } from './testing/fake-server.ts';

const babyId = newId();

async function makeStore() {
  let t = Date.parse('2026-10-29T03:00:00.000Z');
  // A clock that ticks 1 s per read keeps recordedAt ordered and deterministic.
  const now = () => new Date((t += 1000));
  return new EventStore(await openDatabase(`test-${newId()}`), newId(), now);
}

describe('EventStore', () => {
  test('a log is visible immediately and queued for push', async () => {
    const store = await makeStore();
    let changes = 0;
    store.subscribe(() => changes++);
    const { event } = await store.log(babyId, 'diaper', { kind: 'wet' });
    expect(await store.events(babyId)).toEqual([event]);
    expect(await store.pending(10)).toEqual([event]);
    expect(changes).toBe(1);
  });

  test('edit writes the next version', async () => {
    const store = await makeStore();
    const { event } = await store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });
    const edit = await store.edit(event.id, { data: { contents: 'formula', volumeMl: 90 } });
    expect(edit.event.version).toBe(2);
    expect(await store.current(event.id)).toEqual(edit.event);
    expect(await store.pending(10)).toHaveLength(2);
  });

  test('undo a log deletes it; undo the undo brings it back', async () => {
    const store = await makeStore();
    const logged = await store.log(babyId, 'diaper', { kind: 'wet' });
    const undone = await logged.undo();
    expect(undone.event.deleted).toBe(true);
    expect(await store.events(babyId)).toEqual([]);
    const redone = await undone.undo();
    expect(redone.event).toMatchObject({ deleted: false, version: 3, data: { kind: 'wet' } });
    expect(await store.events(babyId)).toHaveLength(1);
  });

  test('undo an edit restores the previous body as a new version', async () => {
    const store = await makeStore();
    const { event } = await store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });
    const edit = await store.edit(event.id, {
      data: { contents: 'breast_milk', volumeMl: 90 },
      notes: 'fussy',
    });
    const undone = await edit.undo();
    expect(undone.event).toMatchObject({
      version: 3,
      notes: null,
      data: { contents: 'formula', volumeMl: 60 },
    });
    const redone = await undone.undo();
    expect(redone.event).toMatchObject({ version: 4, notes: 'fussy' });
  });

  test('undo a remove restores it', async () => {
    const store = await makeStore();
    const { event } = await store.log(babyId, 'weight', { grams: 3450, source: 'home' });
    const removed = await store.remove(event.id);
    await removed.undo();
    expect((await store.events(babyId)).map((e) => e.id)).toEqual([event.id]);
  });

  test('the next version is above every version held, including ones that lost', async () => {
    const store = await makeStore();
    const { event } = await store.log(babyId, 'diaper', { kind: 'wet' });
    // The other phone's v2 and v3 arrive by pull; ours must become v4.
    await store.applyPull({
      versions: [
        { seq: 1, event },
        { seq: 2, event: { ...event, version: 2, notes: 'a' } },
        { seq: 3, event: { ...event, version: 3, notes: 'b' } },
      ],
      next: 3,
      more: false,
      through: 3,
    });
    const edit = await store.edit(event.id, { notes: 'c' });
    expect(edit.event.version).toBe(4);
  });

  test('invalid writes throw and store nothing', async () => {
    const store = await makeStore();
    await expect(
      store.log(babyId, 'bottle', { contents: 'formula', volumeMl: -1 }),
    ).rejects.toThrow(/data\.volumeMl/);
    expect(await store.pending(10)).toEqual([]);
  });

  test('events are per baby, newest occurrence first, backdating respected', async () => {
    const store = await makeStore();
    const a = await store.log(babyId, 'diaper', { kind: 'wet' });
    const b = await store.log(
      babyId,
      'diaper',
      { kind: 'wet' },
      {
        occurredAt: '2026-10-28T23:00:00.000Z',
      },
    );
    await store.log(newId(), 'diaper', { kind: 'wet' });
    expect((await store.events(babyId)).map((e) => e.id)).toEqual([a.event.id, b.event.id]);
  });

  test('unknown ids cannot be edited', async () => {
    const store = await makeStore();
    await expect(store.edit(newId(), { notes: 'x' })).rejects.toThrow(/Unknown event/);
  });

  test('simultaneous edits each get their own version and both are kept', async () => {
    const store = await makeStore();
    const { event } = await store.log(babyId, 'diaper', { kind: 'wet' });
    const [a, b] = await Promise.all([
      store.edit(event.id, { notes: 'A' }),
      store.edit(event.id, { notes: 'B' }),
    ]);
    expect([a.event.version, b.event.version].sort()).toEqual([2, 3]);
    const held = await store.db.getAllFromIndex('versions', 'byId', event.id);
    expect(held.map((r) => r.event.notes ?? '').sort()).toEqual(['', 'A', 'B']);
    expect(await store.pending(10)).toHaveLength(3);
  });

  test('two tabs on one database never share a version number', async () => {
    const name = `test-${newId()}`;
    const tab1 = new EventStore(await openDatabase(name), newId());
    const tab2 = new EventStore(await openDatabase(name), newId());
    const { event } = await tab1.log(babyId, 'diaper', { kind: 'wet' });
    const edits = await Promise.all(
      [tab1, tab2, tab1, tab2].map((t, i) => t.edit(event.id, { notes: String(i) })),
    );
    expect(edits.map((e) => e.event.version).sort()).toEqual([2, 3, 4, 5]);
    expect(await tab1.db.count('versions')).toBe(5);
  });

  test('an acknowledgment only retires the body that was submitted', async () => {
    const store = await makeStore();
    const server = new FakeServer();
    const { event } = await store.log(babyId, 'diaper', { kind: 'wet' });
    const submitted = await store.pending(10);
    const response = server.push(submitted);
    // The pending row changes after submission (not reachable through the store's own
    // writes, which never reuse a version; this pins the acknowledgment's own guard).
    const changed = { ...event, notes: 'changed' };
    await store.db.put('versions', {
      key: rowKey(changed, null),
      id: event.id,
      babyId,
      seq: null,
      pending: 1,
      event: changed,
    });
    const [result] = response.results;
    if (result?.status !== 'accepted') throw new Error('expected an accepted push');
    await store.applyPushResults(submitted, response.results);
    expect(await store.pending(10)).toEqual([changed]);
    const synced = await store.db.get('versions', rowKey(event, result.seq));
    expect(synced?.event).toEqual(event);
  });

  test('a result for a version that was not submitted changes nothing', async () => {
    const store = await makeStore();
    const { event } = await store.log(babyId, 'diaper', { kind: 'wet' });
    await store.applyPushResults([], [{ id: event.id, version: 1, seq: 1, status: 'accepted' }]);
    expect(await store.pending(10)).toEqual([event]);
  });

  test('hasSynced is false until a version of the baby has a seq', async () => {
    const store = await makeStore();
    const { event } = await store.log(babyId, 'diaper', { kind: 'wet' });
    expect(await store.hasSynced(babyId)).toBe(false);
    await store.applyPushResults(
      [event],
      [{ id: event.id, version: event.version, status: 'accepted', seq: 7 }],
    );
    expect(await store.hasSynced(babyId)).toBe(true);
    expect(await store.hasSynced(newId())).toBe(false);
  });

  test('resetCursor pulls from the start next time', async () => {
    const store = await makeStore();
    await store.applyPull({ versions: [], next: 42, more: false, through: 42 });
    expect(await store.cursor()).toBe(42);
    await store.resetCursor();
    expect(await store.cursor()).toBe(0);
  });
});

describe('sign-out stops local writes (step 3b)', () => {
  test('with the flag set, log, edit, undo and moveBaby are refused and bump nothing', async () => {
    const store = await makeStore();
    const logged = await store.log(babyId, 'diaper', { kind: 'wet' });
    const before = await store.snapshot();
    await store.beginSignOut();
    expect(await store.signingOut()).toBe(true);

    await expect(
      store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 }),
    ).rejects.toBeInstanceOf(SigningOut);
    await expect(store.edit(logged.event.id, { notes: 'x' })).rejects.toBeInstanceOf(SigningOut);
    await expect(logged.undo()).rejects.toBeInstanceOf(SigningOut);
    await expect(store.moveBaby(babyId, newId())).rejects.toBeInstanceOf(SigningOut);
    expect(await store.snapshot()).toEqual(before);
    expect(await store.events(babyId)).toEqual([logged.event]);

    await store.endSignOut();
    expect(await store.signingOut()).toBe(false);
    await store.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });
    expect((await store.snapshot()).gen).toBe(before.gen + 1);
  });

  test('another tab: a write started before the flag is in the snapshot, one after aborts', async () => {
    // Three tabs on one IndexedDB. B's transaction opens before A sets the flag, so IndexedDB
    // commits it first; C's opens after and sees the flag.
    const name = `test-${newId()}`;
    const [a, b, c] = await Promise.all(
      [0, 1, 2].map(async () => new EventStore(await openDatabase(name), newId())),
    );
    const author = a!.authorId;
    for (const tab of [b!, c!]) tab.authorId = author;
    const written = b!.log(babyId, 'diaper', { kind: 'wet' });
    await a!.beginSignOut();
    const refused = c!.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });

    const { event } = await written;
    await expect(refused).rejects.toBeInstanceOf(SigningOut);
    const snapshot = await a!.snapshot();
    expect(snapshot.pending).toEqual([event]);
    expect(snapshot.gen).toBe(1);

    // Cancelling lets C write again, above the snapshot.
    await a!.endSignOut();
    await c!.log(babyId, 'bottle', { contents: 'formula', volumeMl: 60 });
    expect((await a!.snapshot()).gen).toBe(2);
  });
});
