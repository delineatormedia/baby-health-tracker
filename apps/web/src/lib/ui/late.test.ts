import 'fake-indexeddb/auto';
import { evaluate, type CheckResult } from '@bht/insights';
import { newId, type BabyEvent, type HouseholdDevice } from '@bht/schema';
import { afterEach, describe, expect, test } from 'vitest';
import { openDatabase } from '../data/db.ts';
import { EventStore } from '../data/store.ts';
import { SyncClient } from '../data/sync.ts';
import { FakeServer, FakeTransport } from '../data/testing/fake-server.ts';
import { syncedSpans, type ClockSample, type Spans, type SyncView } from '../data/watermarks.ts';
import {
  cover,
  findLate,
  lateIn,
  lateText,
  LateTracker,
  LATE_KEEP_MS,
  versionKey,
} from './late.ts';
import { vouches } from './readings.ts';

// Late uploads reopen windows (#5 step 3b, SYNC_PLAN "A returning phone" and its tests).

const S = 1_000;
const MIN = 60 * S;
const H = 60 * MIN;
const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function kv() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

function entry(authorId: string, at: number, type: BabyEvent['type'] = 'diaper'): BabyEvent {
  const base = {
    id: newId(),
    babyId: newId(),
    authorId,
    occurredAt: iso(at),
    recordedAt: iso(at),
    version: 1,
    deleted: false,
    notes: null,
  };
  return type === 'count_without'
    ? { ...base, type, data: { deviceId: newId(), start: null, end: iso(at) } }
    : ({ ...base, type: 'diaper', data: { kind: 'wet' } } as BabyEvent);
}

function device(deviceId: string, memberName: string): HouseholdDevice {
  return {
    deviceId,
    memberName,
    watermark: null,
    lastSeenAt: T0,
    removedAt: null,
    signedOutAt: null,
  };
}

describe('cover', () => {
  test('cuts spans off at now, so an open removal or vouch counts only for time passed', () => {
    expect(cover([], [[T0 - H, Infinity]], T0)).toEqual([[T0 - H, T0]]);
    expect(cover([[-Infinity, T0 - 2 * H]], [[T0 - H, T0 + H]], T0)).toEqual([
      [-Infinity, T0 - 2 * H],
      [T0 - H, T0],
    ]);
  });
});

describe('findLate', () => {
  const self = newId();
  const sam = newId();
  const covered: Spans = [[-Infinity, T0]];

  test('a new entry from another phone dated inside a covered span is late', () => {
    const e = entry(sam, T0 - H);
    expect(findLate(new Set(), [e], covered, self)).toEqual([
      { key: versionKey(e), authorId: sam, at: T0 - H },
    ]);
  });

  test('entries seen before, this phone’s own, parents’ marks, and ones past the span are not', () => {
    const seen = entry(sam, T0 - H);
    const own = entry(self, T0 - H);
    const mark = entry(sam, T0 - H, 'count_without');
    const after = entry(sam, T0 + S);
    expect(findLate(new Set([versionKey(seen)]), [seen, own, mark, after], covered, self)).toEqual(
      [],
    );
  });

  test('an edit is a new version, so an edit arriving late is late', () => {
    const e = entry(sam, T0 - H);
    const edit = { ...e, version: 2 };
    expect(findLate(new Set([versionKey(e)]), [edit], covered, self)).toHaveLength(1);
  });
});

describe('lateText', () => {
  const sam = device(newId(), 'Sam');
  const ana = device(newId(), 'Ana');
  const at = (d: HouseholdDevice) => ({ key: newId(), authorId: d.deviceId, at: T0 });

  test('names the phone, or the phones, the entries came from', () => {
    expect(lateText([at(sam), at(sam)], [sam])).toBe(
      'Updated: entries from Sam’s phone arrived late',
    );
    expect(lateText([at(sam), at(ana)], [sam, ana])).toBe(
      'Updated: entries from Sam and Ana’s phones arrived late',
    );
  });

  test('a phone missing from the list is "another phone"', () => {
    expect(lateText([at(sam)], null)).toBe('Updated: entries from another phone arrived late');
    expect(lateText([at(sam), at(ana)], [sam])).toBe(
      'Updated: entries from another phone arrived late',
    );
  });

  test('lateIn keeps the entries inside the window, ends included', () => {
    const l = [T0 - H, T0, T0 + S].map((t) => ({ key: String(t), authorId: 'x', at: t }));
    expect(lateIn(l, T0 - H, T0).map((x) => x.at)).toEqual([T0 - H, T0]);
  });
});

describe('LateTracker', () => {
  const self = newId();
  const sam = newId();
  const baby = newId();

  test('the first read of a baby only sets what was seen', () => {
    const t = new LateTracker(kv(), 'h');
    expect(t.observe(baby, [entry(sam, T0 - H)], [[-Infinity, T0]], T0, self)).toEqual([]);
  });

  test('a different baby starts over: a joining phone’s move is not late', () => {
    const t = new LateTracker(kv(), 'h');
    t.observe(baby, [], [[-Infinity, T0]], T0, self);
    expect(t.observe(newId(), [entry(sam, T0 - H)], [], T0, self)).toEqual([]);
  });

  test('after a reload, the first pull is checked against what the last session covered', () => {
    const store = kv();
    const before = new LateTracker(store, 'h');
    before.observe(baby, [], [[-Infinity, T0]], T0, self);
    // Reloaded: no sample, so the session covers nothing until its pull is adopted.
    const after = new LateTracker(store, 'h');
    after.observe(baby, [], [], T0 + H, self);
    const late = entry(sam, T0 - MIN);
    expect(after.observe(baby, [late], [], T0 + H, self)).toHaveLength(1);
    // And the note itself survives the next reload.
    expect(new LateTracker(store, 'h').late.map((l) => l.key)).toEqual([versionKey(late)]);
  });

  test('households are kept apart', () => {
    const store = kv();
    new LateTracker(store, 'h').observe(baby, [], [[-Infinity, T0]], T0, self);
    const other = new LateTracker(store, 'other');
    other.observe(baby, [], [], T0, self);
    expect(other.observe(baby, [entry(sam, T0 - H)], [], T0, self)).toEqual([]);
  });

  test('two tabs add to each other, and old marks are dropped', () => {
    const store = kv();
    const a = new LateTracker(store, 'h');
    const b = new LateTracker(store, 'h');
    a.observe(baby, [], [[-Infinity, T0]], T0, self);
    b.observe(baby, [], [], T0, self);
    const old = entry(sam, T0 - LATE_KEEP_MS - H);
    const late = entry(sam, T0 - H);
    b.observe(baby, [old, late], [], T0, self);
    a.observe(baby, [old, late], [], T0, self);
    expect(new LateTracker(store, 'h').late.map((l) => l.key)).toEqual([versionKey(late)]);
  });

  test('damaged storage loads as empty', () => {
    const store = kv();
    store.setItem('bht.late.h', '{"covered":[[1,"x"],null,[null,null]],"late":[{"key":1}]}');
    const t = new LateTracker(store, 'h');
    expect(t.late).toEqual([]);
    t.observe(baby, [], [], T0, self);
    // [null, null] reads as all time, which a later entry then sits inside.
    expect(t.observe(baby, [entry(sam, T0 - H)], [], T0, self)).toHaveLength(1);
  });
});

// --- The two scenarios from SYNC_PLAN's tests, end to end over the fake server ---

const clients: SyncClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) void c.stop();
});

/**
 * Two phones on one fake server with agreed clocks. Mom's side mirrors app.svelte.ts: every
 * re-read of the log goes through the tracker with the spans Readings used until then, and
 * Readings evaluates against the adopted list and sample.
 */
async function household(birth = T0 - 50 * H) {
  const server = new FakeServer();
  const babyId = newId();
  const clock = { wall: () => server.now, mono: () => server.now - T0 };
  const adopted: { devices: HouseholdDevice[] | null; sample: ClockSample | null } = {
    devices: null,
    sample: null,
  };
  const make = async (name: string, onAdopt?: (d: HouseholdDevice[], s: ClockSample) => void) => {
    const store = new EventStore(
      await openDatabase(`late-${newId()}`),
      newId(),
      () => new Date(server.now),
    );
    server.addDevice(store.authorId, name);
    const sync = new SyncClient(store, new FakeTransport(server), {
      baseDelayMs: 3_600_000,
      random: () => 1,
      clock,
      onAdopt,
    });
    clients.push(sync);
    return { store, sync };
  };
  const mom = await make('Mom', (devices, sample) => Object.assign(adopted, { devices, sample }));
  const dad = await make('Sam');
  const tracker = new LateTracker(kv(), 'household');
  let events: BabyEvent[] = [];

  const view = (): SyncView => ({
    devices: adopted.devices,
    current: adopted.devices !== null,
    self: mom.store.authorId,
    sample: adopted.sample,
    wall: server.now,
    mono: clock.mono(),
    vouches: vouches(events),
  });
  /** Mom's Readings: the no_urine check, which one wet diaper decides for a breastfed baby. */
  const noUrine = (): CheckResult =>
    evaluate({
      baby: { birthAt: iso(birth), sex: 'female' },
      events,
      now: iso(server.now),
      fullyLogged: [{ start: iso(birth), end: iso(server.now) }],
      synced: syncedSpans(view()).map(([s, e]) => ({
        start: Number.isFinite(s) ? iso(s) : null,
        end: Number.isFinite(e) ? iso(e) : null,
      })),
    }).find((c) => c.check === 'no_urine')!;
  /** Mom's phone syncs, then re-reads the log against the spans it counted until now. */
  const momSyncs = async () => {
    const spans = syncedSpans(view());
    await mom.sync.sync();
    const next = await mom.store.events(babyId);
    tracker.observe(babyId, next, spans, server.now, mom.store.authorId);
    events = next;
  };
  const note = (r: CheckResult) => {
    const late = lateIn(tracker.late, Date.parse(r.window.start), Date.parse(r.window.end));
    return late.length > 0 ? lateText(late, adopted.devices) : null;
  };
  const wet = (store: EventStore, at: number) =>
    store.log(babyId, 'diaper', { kind: 'wet' }, { occurredAt: iso(at) });
  /** Mom breastfeeds at these times: the rule is for breastfed babies. */
  const feeds = async (...times: number[]) => {
    for (const t of times) {
      await mom.store.log(
        babyId,
        'breastfeed',
        { side: 'left', durationSeconds: 15 * 60 },
        { occurredAt: iso(t) },
      );
    }
  };
  return { server, mom, dad, momSyncs, noUrine, note, wet, feeds, tracker };
}

describe('late uploads reopen assessed windows', () => {
  test('remove, rejoin, late upload: the window after removedAt reopens and its result changes', async () => {
    // Day 3 at T0 + 26 h. The gap between Sam's watermark and the removal is over a day back,
    // outside the feeding day no_urine reads.
    const h = await household(T0 + 26 * H - 60 * H);
    // Both phones synced at T0. Sam's phone then goes missing.
    await h.dad.sync.sync();
    await h.momSyncs();
    // A parent removes Sam's phone at T0 + 1 h: from then on, windows do not wait for it.
    h.server.now = T0 + H;
    h.server.devices.get(h.dad.store.authorId)!.removedAt = h.server.now;
    // The missing phone still logs a wet diaper at T0 + 20 h, which stays on it.
    await h.wet(h.dad.store, T0 + 20 * H);
    await h.feeds(T0 + 5 * H, T0 + 12 * H, T0 + 22 * H);
    h.server.now = T0 + 26 * H;
    await h.momSyncs();
    await h.momSyncs();
    const before = h.noUrine();
    expect(before).toMatchObject({ status: 'flag' });
    expect(Date.parse(before.window.start)).toBeGreaterThan(T0 + H);
    expect(h.note(before)).toBeNull();

    // Sam's phone rejoins as a new device, and its kept entry from T0 + 20 h uploads.
    h.dad.store.authorId = newId();
    h.server.addDevice(h.dad.store.authorId, 'Sam');
    h.server.now = T0 + 26 * H + MIN;
    await h.dad.sync.sync();
    await h.momSyncs();

    const after = h.noUrine();
    expect(after).toMatchObject({ status: 'ok' });
    expect(h.note(after)).toBe('Updated: entries from Sam’s phone arrived late');
  });

  test('late return: a backdated entry from the returning phone reopens an assessed window', async () => {
    const h = await household();
    await h.dad.sync.sync();
    await h.feeds(T0 + 2 * H, T0 + 6 * H);
    h.server.now = T0 + 9 * H;
    await h.dad.sync.sync();
    await h.momSyncs();
    await h.momSyncs();
    const before = h.noUrine();
    expect(before).toMatchObject({ status: 'flag' });

    // Sam logs a wet diaper "2 h ago", into the window Mom's phone already assessed.
    h.server.now = T0 + 9 * H + 5 * MIN;
    await h.wet(h.dad.store, T0 + 7 * H);
    await h.dad.sync.sync();
    await h.momSyncs();

    const after = h.noUrine();
    expect(after).toMatchObject({ status: 'ok' });
    expect(h.note(after)).toBe('Updated: entries from Sam’s phone arrived late');
  });

  test('control: an entry logged after the watermark is new data, not late', async () => {
    const h = await household();
    h.server.now = T0 + 9 * H;
    await h.dad.sync.sync();
    await h.momSyncs();
    await h.momSyncs();
    h.server.now = T0 + 9 * H + 5 * MIN;
    await h.wet(h.dad.store, h.server.now);
    await h.dad.sync.sync();
    await h.momSyncs();
    expect(h.tracker.late).toEqual([]);
  });
});
