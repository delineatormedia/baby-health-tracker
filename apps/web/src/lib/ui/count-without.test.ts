import 'fake-indexeddb/auto';
import { evaluate, type CheckResult } from '@bht/insights';
import { newId, type BabyEvent, type HouseholdDevice } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { openDatabase } from '../data/db.ts';
import { EventStore } from '../data/store.ts';
import { coveredThrough, syncedSpans, type SyncView } from '../data/watermarks.ts';
import { vouches, vouchesIn } from './readings.ts';

// "Count without Sam’s phone" and "Wait for the phone" (#5 step 3b), through the store the
// Readings page writes to: taking the mark back makes the check wait on Sam's phone again.

const H = 3_600_000;
const NOW = Date.parse('2026-10-29T20:00:00.000Z');
const iso = (t: number) => new Date(t).toISOString();

async function readings() {
  const store = new EventStore(
    await openDatabase(`vouch-${newId()}`),
    newId(),
    () => new Date(NOW),
  );
  const babyId = newId();
  const birth = NOW - 50 * H;
  // Sam's phone last synced 3 h ago; this phone's clock agrees with the server's.
  const sam: HouseholdDevice = {
    deviceId: newId(),
    memberName: 'Sam',
    watermark: NOW - 3 * H,
    lastSeenAt: NOW,
    removedAt: null,
    signedOutAt: null,
  };
  const self: HouseholdDevice = {
    ...sam,
    deviceId: store.authorId,
    memberName: 'Ana',
    watermark: NOW,
  };
  const view = (events: readonly BabyEvent[]): SyncView => ({
    devices: [self, sam],
    current: true,
    self: store.authorId,
    sample: { tSend: NOW, pSend: 0, serverNow: NOW, tRecv: NOW },
    wall: NOW,
    mono: 0,
    vouches: vouches(events),
  });
  /** The page's no_urine result, evaluated as Readings does against the log as stored. */
  const noUrine = async (): Promise<{ r: CheckResult; events: BabyEvent[] }> => {
    const events = await store.events(babyId);
    const r = evaluate({
      baby: { birthAt: iso(birth), sex: 'female' },
      events,
      now: iso(NOW),
      fullyLogged: [{ start: iso(birth), end: iso(NOW) }],
      synced: syncedSpans(view(events)).map(([s, e]) => ({
        start: Number.isFinite(s) ? iso(s) : null,
        end: Number.isFinite(e) ? iso(e) : null,
      })),
    }).find((c) => c.check === 'no_urine')!;
    return { r, events };
  };
  // A wet diaper 9 h ago and breastfeeds since: no_urine reaches back past Sam's watermark.
  await store.log(babyId, 'diaper', { kind: 'wet' }, { occurredAt: iso(NOW - 9 * H) });
  for (const t of [NOW - 8 * H, NOW - 5 * H, NOW - 2 * H]) {
    await store.log(
      babyId,
      'breastfeed',
      { side: 'left', durationSeconds: 900 },
      { occurredAt: iso(t) },
    );
  }
  /** The page's countWithout(): a mark from Sam's converted watermark to now. */
  const countWithout = async () => {
    const from = coveredThrough(view([]), sam);
    await store.log(babyId, 'count_without', {
      deviceId: sam.deviceId,
      start: from === null ? null : iso(from),
      end: iso(NOW),
    });
  };
  return { store, noUrine, countWithout };
}

describe('"Wait for the phone" takes a Count-without back', () => {
  test('the check waits, is assessed once counted without, and waits again once taken back', async () => {
    const { store, noUrine, countWithout } = await readings();

    const waiting = await noUrine();
    expect(waiting.r).toMatchObject({ status: 'not_enough_data', reason: 'not_synced' });

    await countWithout();
    const counted = await noUrine();
    expect(counted.r.status).not.toBe('not_enough_data');
    const marks = vouchesIn(counted.events, counted.r.window);
    expect(marks).toHaveLength(1);

    // The page's unvouch(): remove every mark on this check's window.
    for (const m of marks) await store.remove(m.id);
    const back = await noUrine();
    expect(await store.current(marks[0]!.id)).toMatchObject({ deleted: true });
    expect(vouchesIn(back.events, back.r.window)).toEqual([]);
    expect(back.r).toMatchObject({ status: 'not_enough_data', reason: 'not_synced' });
  });
});
