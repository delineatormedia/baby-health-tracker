import 'fake-indexeddb/auto';
import { newId } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { openDatabase } from '../data/db.ts';
import { EventStore } from '../data/store.ts';
import {
  lastPump,
  pumpData,
  pumpSide,
  runningPump,
  startPumpData,
  stopPumpData,
  stoppedPump,
  stopSeconds,
  type Pump,
} from './logic.ts';

const babyId = newId();
const author = newId();
const START = Date.parse('2026-10-29T03:00:00.000Z');

/** A page load: a fresh connection to the same IndexedDB, as after a reload. */
async function load(name: string, at: () => number) {
  const db = await openDatabase(name);
  return { db, store: new EventStore(db, author, () => new Date(at())) };
}

describe('pump Stop is durable (#32)', () => {
  test('Start → Stop → reload → form restored → Log saves the duration up to the Stop', async () => {
    const name = `pump-${newId()}`;
    let now = START;
    let page = await load(name, () => now);

    await page.store.log(babyId, 'pump', startPumpData('both'), {
      occurredAt: new Date(START).toISOString(),
    });
    // Stop 25 minutes in, the way the page does: the duration is written at once.
    now = START + 25 * 60_000;
    const running = runningPump(await page.store.events(babyId))!;
    const s = stopSeconds(running.occurredAt, now)!;
    await page.store.edit(running.id, { data: stopPumpData(pumpSide(running), s) });

    // Reload five minutes later, before Log.
    page.db.close();
    now += 5 * 60_000;
    page = await load(name, () => now);
    const events = await page.store.events(babyId);
    expect(runningPump(events)).toBeUndefined();
    const stopped = stoppedPump(events)!;
    expect(stopped.id).toBe(running.id);
    expect(stopped.data).toMatchObject({ side: 'both', durationSeconds: 1500 });
    expect(lastPump(events)).toBeUndefined();

    // Log from the restored form: the stored duration, not the time since the start.
    await page.store.edit(stopped.id, {
      data: pumpData(
        pumpSide(stopped),
        { left: 50, right: 0 },
        false,
        stopped.data.durationSeconds!,
      ),
    });
    const done = (await page.store.current(stopped.id)) as Pump;
    expect(done.data).toEqual({
      leftMl: 50,
      rightMl: 0,
      afterFeed: false,
      side: 'both',
      durationSeconds: 1500,
    });
    expect(stoppedPump(await page.store.events(babyId))).toBeUndefined();
    page.db.close();
  });

  test('Undo on Stop puts the pump back to running; Undo on Log back to stopped', async () => {
    let now = START;
    const { db, store } = await load(`pump-${newId()}`, () => now);
    const { event } = await store.log(babyId, 'pump', startPumpData('left'));
    now += 10 * 60_000;
    const stop = await store.edit(event.id, { data: stopPumpData('left', 600) });
    await stop.undo();
    expect(runningPump(await store.events(babyId))?.id).toBe(event.id);

    const again = await store.edit(event.id, { data: stopPumpData('left', 660) });
    expect(again.event.data).toMatchObject({ durationSeconds: 660 });
    const log = await store.edit(event.id, {
      data: pumpData('left', { left: 40, right: 0 }, false, 660),
    });
    await log.undo();
    expect(stoppedPump(await store.events(babyId))?.data).toMatchObject({ durationSeconds: 660 });
    db.close();
  });

  test('a stopped pump with volumes on the wrong sides is refused', async () => {
    const { db, store } = await load(`pump-${newId()}`, () => START);
    const { event } = await store.log(babyId, 'pump', startPumpData('left'));
    await store.edit(event.id, { data: stopPumpData('left', 600) });
    await expect(
      store.edit(event.id, {
        data: { leftMl: 40, rightMl: 10, afterFeed: false, side: 'left', durationSeconds: 600 },
      }),
    ).rejects.toThrow();
    db.close();
  });
});
