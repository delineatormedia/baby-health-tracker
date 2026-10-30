import {
  newId,
  resolveAll,
  SCHEMA_VERSION,
  type BabyEvent,
  type PullResponse,
  type PushResponse,
} from '@bht/schema';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { ensureHousehold, MIGRATIONS, openDatabase } from './db.ts';

const A = newId();
const B = newId();
const babyA = newId();
const babyB = newId();
const T = '2026-10-29T03:00:00.000Z';

/** A server whose session is the household named in the x-test-household header. */
function server() {
  const db = openDatabase(':memory:');
  ensureHousehold(db, A, [babyA]);
  ensureHousehold(db, B, [babyB]);
  const app = createApp(db, {
    session: (c) => {
      const id = c.req.header('x-test-household');
      return id ? { householdId: id } : null;
    },
    now: () => new Date(T),
  });
  return { db, app };
}

type App = ReturnType<typeof server>['app'];

function push(app: App, household: string, events: unknown[], schemaVersion = SCHEMA_VERSION) {
  return app.request('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-household': household },
    body: JSON.stringify({ schemaVersion, events }),
  });
}

async function pushOk(app: App, household: string, events: unknown[]) {
  const res = await push(app, household, events);
  expect(res.status).toBe(200);
  return ((await res.json()) as PushResponse).results;
}

async function pullAll(app: App, household: string, after = 0, limit = 1000, through?: number) {
  const q = `after=${after}&limit=${limit}` + (through === undefined ? '' : `&through=${through}`);
  const res = await app.request(`/api/sync?${q}`, {
    headers: { 'x-test-household': household },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PullResponse;
}

function event(over: Partial<BabyEvent> & Pick<BabyEvent, 'type' | 'data'>): BabyEvent {
  return {
    id: newId(),
    babyId: babyA,
    authorId: newId(),
    occurredAt: T,
    recordedAt: T,
    version: 1,
    deleted: false,
    notes: null,
    ...over,
  } as BabyEvent;
}

/** Every shape the web app writes today. */
const SHAPES: BabyEvent[] = [
  event({ type: 'diaper', data: { kind: 'wet' } }),
  event({
    type: 'diaper',
    data: {
      kind: 'dirty',
      stool: { color: 'yellow', consistency: 'seedy', size: null, flags: [] },
    },
  }),
  event({ type: 'bottle', data: { contents: 'formula', volumeMl: 60 } }),
  // A finished feed timed per side, with a pause.
  event({
    type: 'breastfeed',
    data: {
      side: 'both',
      durationSeconds: 900,
      segments: [
        { side: 'left', seconds: 600 },
        { side: 'right', seconds: 300 },
      ],
      pausedSeconds: 120,
    },
  }),
  // A running feed, paused right now.
  event({
    type: 'breastfeed',
    data: {
      side: 'left',
      durationSeconds: null,
      segments: [{ side: 'left', seconds: null }],
      pausedSeconds: 30,
      pausedAt: T,
    },
  }),
  // A typed feed from before per-side timing.
  event({ type: 'breastfeed', data: { side: 'right', durationSeconds: 600 } }),
  // A running pump, a stopped pump waiting for its amount, and a logged one.
  event({
    type: 'pump',
    data: { leftMl: null, rightMl: null, afterFeed: false, side: 'both', durationSeconds: null },
  }),
  event({
    type: 'pump',
    data: { leftMl: null, rightMl: null, afterFeed: false, side: 'left', durationSeconds: 900 },
  }),
  event({
    type: 'pump',
    data: { leftMl: 40, rightMl: 35, afterFeed: true, side: 'both', durationSeconds: 1200 },
  }),
  event({ type: 'weight', data: { grams: 3610, source: 'home' } }),
  event({ type: 'weighted_feed', data: { beforeGrams: 3600, afterGrams: 3660, side: 'left' } }),
  event({
    type: 'missed_logs',
    data: { start: '2026-10-28T12:00:00.000Z', end: '2026-10-29T12:00:00.000Z' },
  }),
];

describe('POST and GET /api/sync', () => {
  test('accepts every event shape the app writes and pulls them back exactly', async () => {
    const { app } = server();
    const results = await pushOk(app, A, SHAPES);
    expect(results.map((r) => r.status)).toEqual(SHAPES.map(() => 'accepted'));
    const page = await pullAll(app, A);
    expect(page.versions.map((v) => v.event)).toEqual(SHAPES);
    expect(page.more).toBe(false);
  });

  test('two clients editing the same event converge on the same version', async () => {
    const { app } = server();
    const first = event({ type: 'bottle', data: { contents: 'formula', volumeMl: 60 } });
    await pushOk(app, A, [first]);
    // Both phones edit version 1 offline, so both write version 2.
    const mom = { ...first, version: 2, data: { contents: 'formula', volumeMl: 90 } } as BabyEvent;
    const dad = { ...first, version: 2, data: { contents: 'breast_milk', volumeMl: 60 } };
    const [m] = await pushOk(app, A, [mom]);
    const [d] = await pushOk(app, A, [dad]);
    expect(m!.status).toBe('accepted');
    // Same version: the one the server took first (lower seq) wins.
    expect(d!.status).toBe('superseded');
    const momView = resolveAll((await pullAll(app, A)).versions);
    const dadView = resolveAll((await pullAll(app, A)).versions.reverse());
    expect(momView.get(first.id)!.event).toEqual(mom);
    expect(dadView.get(first.id)!.event).toEqual(mom);
  });

  test('a tombstone syncs and wins over the version it deletes', async () => {
    const { app } = server();
    const wet = event({ type: 'diaper', data: { kind: 'wet' } });
    await pushOk(app, A, [wet]);
    const [r] = await pushOk(app, A, [{ ...wet, version: 2, deleted: true }]);
    expect(r!.status).toBe('accepted');
    const current = resolveAll((await pullAll(app, A)).versions).get(wet.id)!;
    expect(current.event.deleted).toBe(true);
  });

  test('pushing the same body twice is a duplicate under its original seq', async () => {
    const { app } = server();
    const wet = event({ type: 'diaper', data: { kind: 'wet' } });
    const [a] = await pushOk(app, A, [wet]);
    // Key order differs: the body is compared canonically.
    const reordered = Object.fromEntries(Object.entries(wet).reverse());
    const [b] = await pushOk(app, A, [reordered]);
    expect(b).toEqual({ ...a, status: 'duplicate' });
    expect((await pullAll(app, A)).versions).toHaveLength(1);
  });

  test('invalid versions are rejected with the reason; valid ones beside them still land', async () => {
    const { app } = server();
    const good = event({ type: 'diaper', data: { kind: 'wet' } });
    const bad = { ...event({ type: 'bottle', data: { contents: 'formula', volumeMl: 60 } }) };
    (bad.data as { volumeMl: number }).volumeMl = 5000;
    const extra = { ...good, id: newId(), unknownField: 1 };
    const results = await pushOk(app, A, [bad, good, extra, 'not an event']);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'accepted', 'rejected', 'rejected']);
    expect(results[0]).toMatchObject({ id: bad.id, version: 1 });
    expect((results[0] as { error: string }).error).toMatch(/volumeMl/);
    expect((await pullAll(app, A)).versions.map((v) => v.event.id)).toEqual([good.id]);
  });

  test('a client newer than the server gets 409 and nothing is stored', async () => {
    const { app } = server();
    const res = await push(
      app,
      A,
      [event({ type: 'diaper', data: { kind: 'wet' } })],
      SCHEMA_VERSION + 1,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ upgrade: true });
    expect((await pullAll(app, A)).versions).toEqual([]);
  });

  test('an older client is accepted', async () => {
    const { app } = server();
    const res = await push(app, A, [event({ type: 'diaper', data: { kind: 'wet' } })], 1);
    expect(res.status).toBe(200);
  });

  test('malformed requests get 400 and oversized batches 413', async () => {
    const { app } = server();
    const raw = (body: string) =>
      app.request('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-household': A },
        body,
      });
    expect((await raw('{')).status).toBe(400);
    expect((await raw(JSON.stringify({ events: [] }))).status).toBe(400);
    expect((await raw(JSON.stringify({ schemaVersion: 2, events: {} }))).status).toBe(400);
    const wet = event({ type: 'diaper', data: { kind: 'wet' } });
    expect(
      (
        await push(
          app,
          A,
          Array.from({ length: 501 }, () => wet),
        )
      ).status,
    ).toBe(413);
    expect((await raw('x'.repeat(3 * 1024 * 1024))).status).toBe(413);
    for (const q of ['after=-1', 'after=x', 'limit=0', 'after=1.5', 'through=-1', 'through=x']) {
      const res = await app.request(`/api/sync?${q}`, { headers: { 'x-test-household': A } });
      expect(res.status, q).toBe(400);
    }
  });

  test('pulls page in seq order with next and more', async () => {
    const { app } = server();
    const events = Array.from({ length: 5 }, () =>
      event({ type: 'diaper', data: { kind: 'wet' } }),
    );
    await pushOk(app, A, events);
    const one = await pullAll(app, A, 0, 2);
    expect(one.versions).toHaveLength(2);
    expect(one.more).toBe(true);
    const two = await pullAll(app, A, one.next, 2);
    const three = await pullAll(app, A, two.next, 2);
    expect(three.more).toBe(false);
    const seqs = [...one.versions, ...two.versions, ...three.versions].map((v) => v.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect([...one.versions, ...two.versions, ...three.versions].map((v) => v.event)).toEqual(
      events,
    );
    expect(one.through).toBe(three.next);
    expect(await pullAll(app, A, three.next)).toEqual({
      versions: [],
      next: three.next,
      more: false,
      through: three.next,
      serverNow: Date.parse(T),
      devices: [],
    });
  });

  test('a pull stops at the first page’s through; a push landing mid-pull waits', async () => {
    const { app } = server();
    const wet = () => event({ type: 'diaper', data: { kind: 'wet' } });
    const first = [wet(), wet(), wet()];
    await pushOk(app, A, first);
    const one = await pullAll(app, A, 0, 1);
    expect(one.through).toBe(3);
    expect(one.more).toBe(true);
    // Another phone pushes between pages, and household B pushes too (seq is global).
    const late = wet();
    await pushOk(app, A, [late]);
    await pushOk(app, B, [event({ type: 'diaper', data: { kind: 'wet' }, babyId: babyB })]);
    const two = await pullAll(app, A, one.next, 1, one.through);
    const three = await pullAll(app, A, two.next, 1, one.through);
    expect(two.more).toBe(true);
    expect(three.more).toBe(false);
    expect(three.through).toBe(3);
    expect([...one.versions, ...two.versions, ...three.versions].map((v) => v.event)).toEqual(
      first,
    );
    // Control: without through, the same page would have run on into the late push.
    expect((await pullAll(app, A, two.next, 1)).more).toBe(true);
    // The next pull picks the late push up, and its through skips B's seq.
    const next = await pullAll(app, A, three.next, 1);
    expect(next.versions.map((v) => v.event)).toEqual([late]);
    expect(next).toMatchObject({ more: false, through: 4 });
  });

  test('signed out gets 401 on both routes', async () => {
    const { app } = server();
    expect((await app.request('/api/sync')).status).toBe(401);
    const res = await app.request('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    // Without a session resolver (production until passkeys land), sync is closed.
    const closed = createApp(openDatabase(':memory:'));
    expect((await closed.request('/api/sync')).status).toBe(401);
  });
});

describe('household isolation', () => {
  test('household A cannot read household B', async () => {
    const { app } = server();
    const bEvent = event({ type: 'diaper', data: { kind: 'wet' }, babyId: babyB });
    await pushOk(app, B, [bEvent]);
    const aEvent = event({ type: 'diaper', data: { kind: 'wet' } });
    await pushOk(app, A, [aEvent]);
    expect((await pullAll(app, A)).versions.map((v) => v.event.id)).toEqual([aEvent.id]);
    expect((await pullAll(app, B)).versions.map((v) => v.event.id)).toEqual([bEvent.id]);
  });

  test('household A cannot write into an event B owns, and learns nothing about it', async () => {
    const { app } = server();
    const bEvent = event({ type: 'diaper', data: { kind: 'wet' }, babyId: babyB });
    await pushOk(app, B, [bEvent]);
    const [same] = await pushOk(app, A, [bEvent]);
    const [edit] = await pushOk(app, A, [{ ...bEvent, version: 2, deleted: true }]);
    expect(same).toEqual({ id: bEvent.id, version: 1, status: 'rejected', error: 'Unknown event' });
    expect(edit).toMatchObject({ status: 'rejected', error: 'Unknown event' });
    const current = resolveAll((await pullAll(app, B)).versions).get(bEvent.id)!;
    expect(current.event).toEqual(bEvent);
    expect((await pullAll(app, A)).versions).toEqual([]);
  });
});

describe('database', () => {
  test('migrations run once and the version survives a reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bht-'));
    try {
      const path = join(dir, 'bht.db');
      const db = openDatabase(path);
      ensureHousehold(db, A, [babyA]);
      const app = createApp(db, { session: () => ({ householdId: A }) });
      const wet = event({ type: 'diaper', data: { kind: 'wet' } });
      await app.request('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, events: [wet] }),
      });
      db.close();
      const again = openDatabase(path);
      expect(again.prepare('PRAGMA user_version').get()).toEqual({
        user_version: MIGRATIONS.length,
      });
      const res = await createApp(again, { session: () => ({ householdId: A }) }).request(
        '/api/sync',
      );
      const page = (await res.json()) as PullResponse;
      expect(page.versions.map((v) => v.event)).toEqual([wet]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a step 1 database upgrades with its versions kept and no member stamped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bht-'));
    try {
      const path = join(dir, 'bht.db');
      const old = new DatabaseSync(path);
      old.exec(MIGRATIONS[0]!);
      old.exec('PRAGMA user_version = 1');
      old.exec(`INSERT INTO households VALUES ('${A}', '${T}')`);
      old
        .prepare(
          `INSERT INTO event_versions (household_id, event_id, version, baby_id, body, received_at)
           VALUES (?, 'e1', 1, ?, '{}', ?)`,
        )
        .run(A, babyA, T);
      old.close();
      const db = openDatabase(path);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(db.prepare('SELECT event_id, member_id FROM event_versions').all()).toEqual([
        { event_id: 'e1', member_id: null },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a database from a newer server is refused, not downgraded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bht-'));
    try {
      const path = join(dir, 'bht.db');
      const newer = new DatabaseSync(path);
      newer.exec('PRAGMA user_version = 99');
      newer.close();
      expect(() => openDatabase(path)).toThrow(/migration 99/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
