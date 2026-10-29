import 'fake-indexeddb/auto';
import { newId } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { openDatabase } from './db.ts';
import { EventStore } from './store.ts';

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
});
