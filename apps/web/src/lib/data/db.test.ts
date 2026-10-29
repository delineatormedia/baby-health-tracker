import 'fake-indexeddb/auto';
import { newId, type BabyEvent } from '@bht/schema';
import { openDB } from 'idb';
import { expect, test } from 'vitest';
import { openDatabase, rowKey } from './db.ts';
import { EventStore } from './store.ts';

test('upgrading a version-1 database keeps every row and adds the rejected index', async () => {
  const name = `test-${newId()}`;
  const babyId = newId();
  const event: BabyEvent = {
    id: newId(),
    babyId,
    authorId: newId(),
    occurredAt: '2026-10-29T03:00:00.000Z',
    recordedAt: '2026-10-29T03:00:00.000Z',
    version: 1,
    deleted: false,
    notes: null,
    type: 'diaper',
    data: { kind: 'wet' },
  };
  // The exact version-1 layout from #13, holding one pending row.
  const v1 = await openDB(name, 1, {
    upgrade(db) {
      const versions = db.createObjectStore('versions', { keyPath: 'key' });
      versions.createIndex('byId', 'id');
      versions.createIndex('byBaby', 'babyId');
      versions.createIndex('byPending', 'pending');
      db.createObjectStore('meta');
    },
  });
  await v1.put('versions', {
    key: rowKey(event, null),
    id: event.id,
    babyId,
    seq: null,
    pending: 1,
    event,
  });
  await v1.put('meta', 7, 'cursor');
  v1.close();

  const db = await openDatabase(name);
  expect(db.version).toBe(2);
  expect([...db.transaction('versions').store.indexNames]).toContain('byRejected');
  const store = new EventStore(db, newId());
  expect(await store.events(babyId)).toEqual([event]);
  expect(await store.pending(10)).toEqual([event]);
  expect(await store.cursor()).toBe(7);
  expect(await store.rejectedCount()).toBe(0);
});
