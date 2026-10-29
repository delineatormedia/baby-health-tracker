import 'fake-indexeddb/auto';
import { newId, SCHEMA_VERSION, type BabyEvent } from '@bht/schema';
import { afterEach, describe, expect, test } from 'vitest';
// The real server (#5), in process: the client is tested against it, not only the fake.
import { createApp } from '../../../../server/src/app.ts';
import {
  ensureDevice,
  ensureHousehold,
  openDatabase as openServerDb,
} from '../../../../server/src/db.ts';
import { openDatabase } from './db.ts';
import { HttpError, type BarrierRequest, type SyncTransport } from './protocol.ts';
import { EventStore } from './store.ts';
import { SyncClient } from './sync.ts';
import { syncedThrough, waitingOn, type ClockSample, type SyncView } from './watermarks.ts';
import type { HouseholdDevice } from '@bht/schema';

const babyId = newId();
const clients: SyncClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

/** The real app, whose session is the phone named in the x-test-device header. */
function realServer() {
  const db = openServerDb(':memory:');
  const household = newId();
  ensureHousehold(db, household, [babyId]);
  const app = createApp(db, {
    session: (c) => {
      const deviceId = c.req.header('x-test-device');
      if (!deviceId) return null;
      ensureDevice(db, household, deviceId);
      return { householdId: household, memberId: `m-${deviceId}`, deviceId };
    },
  });
  return Object.assign(app, { db });
}

/** httpTransport's requests from phone `deviceId`, sent to the in-process app. */
function transportTo(
  app: ReturnType<typeof createApp>,
  schemaVersion = SCHEMA_VERSION,
  deviceId = newId(),
) {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('x-test-device', deviceId);
    const res = await app.request(path, { ...init, headers });
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
    barrier: (req: BarrierRequest) =>
      call('/api/sync/barrier', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      }),
    deviceId,
  } satisfies SyncTransport & { deviceId: string };
}

async function phone(transport: SyncTransport & { deviceId: string }) {
  const store = new EventStore(await openDatabase(`test-${newId()}`), transport.deviceId);
  const seen: { devices: HouseholdDevice[] | null; sample: ClockSample | null } = {
    devices: null,
    sample: null,
  };
  const sync = new SyncClient(store, transport, {
    baseDelayMs: 3_600_000,
    random: () => 1,
    onAdopt: (devices, sample) => Object.assign(seen, { devices, sample }),
  });
  clients.push(sync);
  const view = (): SyncView => ({
    ...seen,
    self: store.authorId,
    wall: Date.now(),
    mono: performance.now(),
  });
  return { store, sync, view };
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

  test('500 valid entries over the 2 MiB body cap drain, and the pull runs', async () => {
    const app = realServer();
    const mom = await phone(transportTo(app));
    // Adversarial's #46 case: 2,000-character Chinese notes put 500 entries past 3 MB.
    const notes = '日'.repeat(2000);
    for (let i = 0; i < 500; i++) await mom.store.log(babyId, 'diaper', { kind: 'wet' }, { notes });
    const dad = await phone(transportTo(app));
    const late = await dad.store.log(babyId, 'diaper', { kind: 'wet' });
    await dad.sync.sync();
    await mom.sync.sync();
    expect(mom.sync.status).toBe('idle');
    expect(await mom.store.pending(1000)).toEqual([]);
    expect(await mom.store.rejectedCount()).toBe(0);
    // Mom's pull ran after her pushes: she has dad's entry too.
    expect(await mom.store.current(late.event.id)).toEqual(late.event);
    await dad.sync.sync();
    expect(await dad.store.events(babyId)).toHaveLength(501);
  }, 60_000);

  test('a newer app than the server keeps its writes pending, then syncs after the upgrade', async () => {
    const app = realServer();
    const ahead = await phone(transportTo(app, SCHEMA_VERSION + 1));
    const { event } = await ahead.store.log(babyId, 'diaper', { kind: 'wet' });
    await ahead.sync.sync();
    expect(ahead.sync.status).toBe('offline');
    expect(await ahead.store.pending(10)).toEqual([event]);
    expect(await ahead.store.rejectedCount()).toBe(0);

    // The same phone once the server runs the app's schema: everything it held goes up.
    const after = new SyncClient(
      ahead.store,
      transportTo(app, SCHEMA_VERSION, ahead.store.authorId),
      {
        baseDelayMs: 3_600_000,
      },
    );
    clients.push(after);
    await after.sync();
    expect(await ahead.store.pending(10)).toEqual([]);
    const other = await phone(transportTo(app));
    await other.sync.sync();
    expect(await other.store.events(babyId)).toEqual([event]);
  });

  test('watermarks: a phone holding an unsynced write holds windows back until it syncs', async () => {
    const app = realServer();
    const mom = await phone(transportTo(app));
    const dad = await phone(transportTo(app));
    await dad.sync.sync();
    await mom.sync.sync();
    // Both phones have a watermark now; mom's windows wait only up to dad's.
    const dadRow = () => mom.view().devices!.find((d) => d.deviceId === dad.store.authorId)!;
    expect(dadRow().watermark).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    const wet = await dad.store.log(babyId, 'diaper', { kind: 'wet' });
    const at = Date.parse(wet.event.recordedAt);
    await mom.sync.sync();
    expect(syncedThrough(mom.view())!).toBeLessThan(at);
    expect(waitingOn(mom.view(), at)).toEqual([dadRow()]);

    await dad.sync.sync();
    await mom.sync.sync();
    expect(await mom.store.current(wet.event.id)).toEqual(wet.event);
    // The drift budget keeps the line two seconds behind dad's barrier.
    await new Promise((r) => setTimeout(r, 2_100));
    await dad.sync.sync();
    await mom.sync.sync();
    expect(waitingOn(mom.view(), at)).toEqual([]);
    expect(syncedThrough(mom.view())!).toBeGreaterThanOrEqual(at);
  });
});
