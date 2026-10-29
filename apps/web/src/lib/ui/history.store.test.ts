import 'fake-indexeddb/auto';
import { evaluate } from '@bht/insights';
import { newId } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { openDatabase } from '../data/db.ts';
import { EventStore } from '../data/store.ts';
import { historyDays } from './history.ts';
import { localZone } from './reports.ts';
import { gramsFromDigits, gramsFromLbOz } from './weight.ts';

const babyId = newId();
const author = newId();

async function phone(name = `history-${newId()}`) {
  let t = Date.parse('2026-10-29T03:00:00.000Z');
  const now = () => new Date((t += 1000));
  return { name, store: new EventStore(await openDatabase(name), author, now) };
}

// A reload is a fresh EventStore on the same IndexedDB database.
const reload = async (name: string) => new EventStore(await openDatabase(name), author);

describe('History edits through the store (#35)', () => {
  test('a time edit and its Undo both survive a reload', async () => {
    const { name, store } = await phone();
    const { event } = await store.log(
      babyId,
      'diaper',
      { kind: 'wet' },
      {
        occurredAt: '2026-10-28T10:00:00.000Z',
      },
    );
    const moved = await store.edit(event.id, { occurredAt: '2026-10-28T09:15:00.000Z' });
    expect((await (await reload(name)).current(event.id))?.occurredAt).toBe(
      '2026-10-28T09:15:00.000Z',
    );
    await moved.undo();
    const after = await (await reload(name)).current(event.id);
    expect(after).toMatchObject({ occurredAt: '2026-10-28T10:00:00.000Z', version: 3 });
  });

  test('a delete leaves History, and Undo brings it back after a reload', async () => {
    const { name, store } = await phone();
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    const { event } = await store.log(
      babyId,
      'bottle',
      { contents: 'formula', volumeMl: 60 },
      {
        occurredAt: '2026-10-28T11:00:00.000Z',
      },
    );
    const removed = await store.remove(event.id);
    expect(historyDays(await (await reload(name)).events(babyId), 0, now, localZone())).toEqual([]);
    await removed.undo();
    const days = historyDays(await (await reload(name)).events(babyId), 0, now, localZone());
    expect(days.flatMap((d) => d.events.map((e) => e.id))).toEqual([event.id]);
  });
});

describe('Weights reach Readings unchanged (#35)', () => {
  test('a birth weight and a day-4 weight in lb/oz drive the weight-loss check', async () => {
    const { store } = await phone();
    const birthAt = '2026-10-20T08:00:00.000Z';
    await store.log(
      babyId,
      'weight',
      { grams: gramsFromDigits('3500')!, source: 'clinic' },
      {
        occurredAt: '2026-10-20T10:00:00.000Z',
      },
    );
    // 6 lb 13 oz is about 3090 g, 11.7% below birth: past the 10% line.
    await store.log(
      babyId,
      'weight',
      { grams: gramsFromLbOz('6', '13')!, source: 'home' },
      {
        occurredAt: '2026-10-24T09:00:00.000Z',
      },
    );
    const now = '2026-10-24T12:00:00.000Z';
    const results = evaluate({
      baby: { birthAt, sex: 'female' },
      events: await store.events(babyId),
      now,
      fullyLogged: [{ start: birthAt, end: now }],
      syncedThrough: now,
    });
    expect(results.find((r) => r.check === 'weight_loss')?.status).toBe('flag');
  });
});
