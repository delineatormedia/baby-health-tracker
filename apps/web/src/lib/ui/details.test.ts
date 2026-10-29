import 'fake-indexeddb/auto';
import { newId, type Stool } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { openDatabase } from '../data/db.ts';
import { EventStore } from '../data/store.ts';
import { saveDetails } from './details.ts';
import type { Diaper } from './logic.ts';

const babyId = newId();
const AT = '2026-10-29T02:00:00.000Z';
const HOUR_EARLIER = '2026-10-29T01:00:00.000Z';
const stool: Stool = { color: 'mustard', consistency: null, size: null, flags: [] };

async function logged(kind: 'dirty' | 'mixed') {
  const store = new EventStore(await openDatabase(`test-${newId()}`), newId());
  const { event } = await store.log(babyId, 'diaper', { kind, stool }, { occurredAt: AT });
  return { store, event: event as Diaper };
}

describe('saveDetails', () => {
  for (const kind of ['dirty', 'mixed'] as const) {
    test(`${kind}: Undo straight after logging removes the diaper`, async () => {
      const { store, event } = await logged(kind);
      const change = await saveDetails(
        store,
        event,
        { stool: { ...stool, size: 'small' }, occurredAt: HOUR_EARLIER },
        true,
      );
      expect(change?.event).toMatchObject({ version: 2, occurredAt: HOUR_EARLIER });
      const undone = await change!.undo();
      expect(undone.event.deleted).toBe(true);
      expect(await store.events(babyId)).toEqual([]);
    });

    test(`${kind}: Undo after reopening to move it restores the exact old time`, async () => {
      const { store, event } = await logged(kind);
      const change = await saveDetails(store, event, { stool, occurredAt: HOUR_EARLIER }, false);
      expect(change?.event).toMatchObject({ version: 2, occurredAt: HOUR_EARLIER });
      const undone = await change!.undo();
      expect(undone.event).toMatchObject({ version: 3, deleted: false, occurredAt: AT });
      expect(await store.events(babyId)).toEqual([undone.event]);
    });

    test(`${kind}: Undo after reopening to add details restores the earlier details`, async () => {
      const { store, event } = await logged(kind);
      const change = await saveDetails(
        store,
        event,
        { stool: { ...stool, consistency: 'seedy', flags: ['mucus'] }, occurredAt: AT },
        false,
      );
      const undone = await change!.undo();
      expect(undone.event).toMatchObject({ deleted: false, occurredAt: AT, data: { kind, stool } });
    });
  }

  test('reopened with nothing changed writes nothing and offers no Undo', async () => {
    const { store, event } = await logged('dirty');
    expect(await saveDetails(store, event, { stool, occurredAt: AT }, false)).toBeNull();
    expect(await store.pending(10)).toHaveLength(1);
  });

  test('just logged with nothing changed still offers Undo of the log', async () => {
    const { store, event } = await logged('dirty');
    const change = await saveDetails(store, event, { stool, occurredAt: AT }, true);
    expect(change?.event).toEqual(event);
    expect((await change!.undo()).event.deleted).toBe(true);
  });
});
