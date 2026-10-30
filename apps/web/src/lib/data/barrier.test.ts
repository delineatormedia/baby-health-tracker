import 'fake-indexeddb/auto';
import { newId, type HouseholdDevice } from '@bht/schema';
import { afterEach, describe, expect, test } from 'vitest';
import { openDatabase } from './db.ts';
import { EventStore } from './store.ts';
import { SyncClient, type SyncOptions } from './sync.ts';
import { FakeServer, FakeTransport } from './testing/fake-server.ts';
import type { ClockSample } from './watermarks.ts';

// The acknowledged write barrier and the adopted device list (#5 step 3b, #17).

const babyId = newId();
const clients: SyncClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

async function phone(server: FakeServer, opts: SyncOptions = {}, name = `test-${newId()}`) {
  const store = new EventStore(await openDatabase(name), newId());
  const transport = new FakeTransport(server);
  const adopted: { devices: HouseholdDevice[]; sample: ClockSample }[] = [];
  const sync = new SyncClient(store, transport, {
    baseDelayMs: 3_600_000,
    random: () => 1,
    onAdopt: (devices, sample) => adopted.push({ devices, sample }),
    ...opts,
  });
  clients.push(sync);
  return { store, transport, sync, adopted, name };
}

const gen = async (store: EventStore) => (await store.snapshot()).gen;
const wet = (store: EventStore) => store.log(babyId, 'diaper', { kind: 'wet' });

describe('write generation', () => {
  test('every local write bumps it; sync results do not', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    expect(await gen(mom.store)).toBe(0);
    const { event, undo } = await wet(mom.store);
    await mom.store.edit(event.id, { notes: 'leaked' });
    await undo();
    expect(await gen(mom.store)).toBe(3);
    await mom.sync.sync();
    expect(await gen(mom.store)).toBe(3);
    await mom.store.moveBaby(babyId, newId());
    expect(await gen(mom.store)).toBe(4);
  });

  test('another tab shares the counter', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const tab = new EventStore(await openDatabase(mom.name), mom.store.authorId);
    await wet(mom.store);
    await wet(tab);
    expect(await gen(mom.store)).toBe(2);
  });
});

describe('barrier', () => {
  test('after a sync, the barrier covers every write, as of a serverNow from before', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    await wet(mom.store);
    await wet(mom.store);
    await mom.sync.sync();
    expect(server.barriers).toEqual([{ deviceId: mom.store.authorId, gen: 2, at: server.now }]);
    expect(server.devices.get(mom.store.authorId)?.watermark).toBe(server.now);
  });

  test('no serverNow heard yet: no barrier', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    mom.transport.failPulls = true;
    await mom.sync.sync();
    expect(mom.transport.barriersSent).toEqual([]);
  });

  test('delayed request: a write while the batch is in flight is outside the barrier', async () => {
    const server = new FakeServer();
    let writeDuringPush: (() => Promise<unknown>) | null = null;
    const mom = await phone(server, {
      prepare: async () => {
        const write = writeDuringPush;
        writeDuringPush = null;
        await write?.();
      },
    });
    const heard = server.now;
    let g = 0;
    let late: Awaited<ReturnType<typeof wet>> | null = null;
    // After the pull, a write lands; while its push is in flight, a minute later, another.
    mom.transport.afterPull = async () => {
      mom.transport.afterPull = null;
      await wet(mom.store);
      g = await gen(mom.store);
      writeDuringPush = async () => {
        server.now += 60_000;
        late = await wet(mom.store);
      };
    };
    await mom.sync.sync();
    expect(late).not.toBeNull();
    // The barrier claims the first write and is dated before the late one reached the server.
    expect(server.barriers).toEqual([{ deviceId: mom.store.authorId, gen: g, at: heard }]);
    expect(server.barriers[0]!.at).toBeLessThan(server.now);
    expect(await gen(mom.store)).toBe(g + 1);
    // The next barrier covers it.
    await mom.sync.sync();
    expect(server.barriers.at(-1)).toMatchObject({ gen: g + 1, at: server.now });
    expect(await mom.store.pending(10)).toEqual([]);
  });

  test('another tab: a write between the snapshot and the barrier has a higher gen', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    const tab = new EventStore(await openDatabase(mom.name), mom.store.authorId);
    await wet(mom.store);
    let written: string | null = null;
    mom.transport.beforeBarrier = async () => {
      mom.transport.beforeBarrier = null;
      written = (await wet(tab)).event.id;
    };
    await mom.sync.sync();
    expect(server.barriers).toEqual([expect.objectContaining({ gen: 1 })]);
    expect(await gen(mom.store)).toBe(2);
    expect(server.log.map((v) => v.event.id)).not.toContain(written);
    await mom.sync.sync();
    expect(server.barriers.at(-1)).toMatchObject({ gen: 2 });
    expect(server.log.map((v) => v.event.id)).toContain(written);
  });

  test('rejected only: no barrier while a refused entry stands; a later accepted edit clears it', async () => {
    const server = new FakeServer();
    // A cap that one long-notes entry cannot fit under: it is refused on this phone.
    const mom = await phone(server, { maxPushBytes: 4_000, pushByteBudget: 3_000 });
    const big = await mom.store.log(
      babyId,
      'diaper',
      { kind: 'wet' },
      { notes: '日'.repeat(2000) },
    );
    await mom.sync.sync();
    expect(await mom.store.pending(10)).toEqual([]);
    expect(await mom.store.rejectedCount()).toBe(1);
    expect(mom.transport.barriersSent).toEqual([]);
    expect(mom.sync.status).toBe('idle');

    await mom.store.edit(big.event.id, { notes: 'shorter' });
    await mom.sync.sync();
    expect(await mom.store.rejectedCount()).toBe(0);
    expect(server.barriers).toEqual([expect.objectContaining({ gen: 2 })]);
  });

  test('an unanswered version holds the barrier back', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    // After the pull, a write lands, and the answer to its push is lost.
    mom.transport.afterPull = async () => {
      mom.transport.afterPull = null;
      await wet(mom.store);
      mom.transport.dropNextPushResponse = true;
    };
    await mom.sync.sync();
    expect(mom.sync.status).toBe('offline');
    expect(server.log).toHaveLength(1);
    expect(mom.transport.barriersSent).toEqual([]);
    await mom.sync.sync();
    expect(server.barriers).toEqual([expect.objectContaining({ gen: 1 })]);
  });
});

describe('adopting the device list', () => {
  test('adopted with the page that reaches through, with that pull’s first-page sample', async () => {
    const server = new FakeServer();
    const dad = await phone(server);
    for (let i = 0; i < 3; i++) await wet(dad.store);
    await dad.sync.sync();
    const clock = { wall: 1_000_000, mono: 50 };
    const mom = await phone(server, {
      pullLimit: 1,
      clock: { wall: () => clock.wall, mono: () => clock.mono },
    });
    const sentAt = { ...clock };
    const serverAtFirstPage = server.now;
    // Every later page comes back five minutes later, on both clocks and the server's.
    mom.transport.afterPull = () => {
      clock.wall += 300_000;
      clock.mono += 300_000;
      server.now += 300_000;
    };
    await mom.sync.sync();
    expect(mom.transport.pulls).toHaveLength(3);
    expect(mom.adopted).toHaveLength(1);
    expect(mom.adopted[0]!.sample).toEqual({
      tSend: sentAt.wall,
      pSend: sentAt.mono,
      serverNow: serverAtFirstPage,
      // The first page also came back five minutes after it left.
      tRecv: sentAt.wall + 300_000,
    });
    expect(mom.adopted[0]!.devices.map((d) => d.deviceId)).toEqual([dad.store.authorId]);
    expect(await mom.store.devices('')).toEqual(mom.adopted[0]!.devices);
  });

  test('an interrupted pull over many pages adopts nothing', async () => {
    const server = new FakeServer();
    const dad = await phone(server);
    for (let i = 0; i < 4; i++) await wet(dad.store);
    await dad.sync.sync();
    const mom = await phone(server, { pullLimit: 1 });
    let pages = 0;
    mom.transport.afterPull = () => {
      if (++pages === 2) mom.transport.failPulls = true;
    };
    await mom.sync.sync();
    expect(mom.sync.status).toBe('offline');
    expect(mom.adopted).toEqual([]);
    expect(await mom.store.devices('')).toBeNull();
    expect(await mom.store.cursor()).toBeGreaterThan(0);

    mom.transport.failPulls = false;
    mom.transport.afterPull = null;
    await mom.sync.sync();
    expect(mom.adopted).toHaveLength(1);
  });

  test('pull race: a barrier landing between pages is not in the adopted list', async () => {
    const server = new FakeServer();
    const dad = await phone(server);
    await wet(dad.store);
    await wet(dad.store);
    await dad.sync.sync();
    const before = server.devices.get(dad.store.authorId)!.watermark;
    const mom = await phone(server, { pullLimit: 1 });
    mom.transport.afterPull = () => {
      mom.transport.afterPull = null;
      server.now += 60_000;
      server.barrier({ deviceId: dad.store.authorId, gen: 3, at: server.now });
    };
    await mom.sync.sync();
    const dadRow = mom.adopted[0]!.devices.find((d) => d.deviceId === dad.store.authorId);
    expect(dadRow?.watermark).toBe(before);
    await mom.sync.sync();
    const next = mom.adopted[1]!.devices.find((d) => d.deviceId === dad.store.authorId);
    expect(next?.watermark).toBe(server.now);
  });

  // Fail closed at the boundary: a row without the wire shape rejects the whole page, before
  // anything from it is written or adopted, so Readings keeps waiting.
  const bad: [string, unknown][] = [
    ['deviceId', 'not-a-ulid'],
    ['memberName', 7],
    ['watermark', '2026-10-29'],
    ['watermark', -1],
    ['lastSeenAt', 1.5],
    ['removedAt', 'yes'],
    ['signedOutAt', 'yes'],
    ['signedOutAt', true],
  ];
  const fields = ['deviceId', 'memberName', 'watermark', 'lastSeenAt', 'removedAt', 'signedOutAt'];
  test.each([
    ...fields.map((field) => [field, 'missing', undefined] as const),
    ...bad.map(([field, value]) => [field, JSON.stringify(value), value] as const),
  ])('a device row with %s %s rejects the page', async (field, _label, value) => {
    const server = new FakeServer();
    const dad = await phone(server);
    await wet(dad.store);
    await dad.sync.sync();
    const mom = await phone(server);
    const pull = mom.transport.pull.bind(mom.transport);
    mom.transport.pull = async (...args) => {
      const page = await pull(...args);
      const row: Record<string, unknown> = { ...page.devices![0]! };
      if (value === undefined) delete row[field];
      else row[field] = value;
      return { ...page, devices: [row as HouseholdDevice] };
    };
    await mom.sync.sync();
    expect(mom.sync.status).toBe('offline');
    expect(mom.sync.error).toBe('Server sent an unreadable device list');
    expect(mom.adopted).toEqual([]);
    expect(await mom.store.devices('')).toBeNull();
    expect(await mom.store.cursor()).toBe(0);
    expect(mom.transport.barriersSent).toEqual([]);
  });

  test('a stopped client adopts nothing', async () => {
    const server = new FakeServer();
    const mom = await phone(server);
    mom.transport.afterPull = () => void mom.sync.stop();
    await mom.sync.sync();
    expect(mom.adopted).toEqual([]);
    expect(await mom.store.devices('')).toBeNull();
  });
});
