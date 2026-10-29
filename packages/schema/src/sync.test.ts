import { describe, expect, test } from 'vitest';
import type { BabyEvent } from './events.ts';
import { newId } from './model.ts';
import {
  canonicalJson,
  compareVersions,
  resolveAll,
  resolveCurrent,
  type StoredVersion,
} from './sync.ts';

const id = newId();
const babyId = newId();
const mom = newId();
const dad = newId();

function version(
  v: number,
  seq: number | null,
  opts: {
    author?: string;
    ml?: number;
    deleted?: boolean;
    recordedAt?: string;
    notes?: string;
  } = {},
): StoredVersion {
  const event: BabyEvent = {
    id,
    babyId,
    authorId: opts.author ?? mom,
    occurredAt: '2026-10-29T03:00:00.000Z',
    recordedAt: opts.recordedAt ?? '2026-10-29T03:00:00.000Z',
    version: v,
    deleted: opts.deleted ?? false,
    notes: opts.notes ?? null,
    type: 'bottle',
    data: { contents: 'formula', volumeMl: opts.ml ?? 60 },
  };
  return { seq, event };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('resolveCurrent', () => {
  test('empty log has no current version', () => {
    expect(resolveCurrent([])).toBeUndefined();
  });

  test('highest version wins', () => {
    const v3 = version(3, 12, { ml: 90 });
    expect(resolveCurrent([version(1, 10), v3, version(2, 11)])).toBe(v3);
  });

  test('client clocks do not decide: a future-dated device cannot dominate', () => {
    // Dad's phone thinks it is next year. Mom's later edit (v3) still wins.
    const dadV2 = version(2, 11, { author: dad, recordedAt: '2027-10-29T03:00:00.000Z' });
    const momV3 = version(3, 12, { author: mom, recordedAt: '2026-10-29T03:05:00.000Z' });
    expect(resolveCurrent([dadV2, momV3])).toBe(momV3);
  });

  test('concurrent edits of the same version: first accepted by the server wins', () => {
    const momV2 = version(2, 20, { author: mom, ml: 90 });
    const dadV2 = version(2, 21, { author: dad, ml: 120, recordedAt: '2026-10-29T04:00:00.000Z' });
    expect(resolveCurrent([dadV2, momV2])).toBe(momV2);
  });

  test('edit/delete collision follows the same rule, in both directions', () => {
    const edit = version(2, 30, { ml: 90 });
    const del = version(2, 31, { deleted: true });
    expect(resolveCurrent([del, edit])).toBe(edit);
    const delFirst = { ...del, seq: 29 };
    expect(resolveCurrent([edit, delFirst])?.event.deleted).toBe(true);
  });

  test('a tombstone with a higher version deletes; a later edit can restore', () => {
    const del = version(2, 40, { deleted: true });
    expect(resolveCurrent([version(1, 39), del])?.event.deleted).toBe(true);
    const restore = version(3, 41, { ml: 60 });
    expect(resolveCurrent([version(1, 39), del, restore])).toBe(restore);
  });

  test('an unsynced local version loses a tie to a synced one', () => {
    const local = version(2, null, { author: dad, ml: 120 });
    const remote = version(2, 50, { author: mom, ml: 90 });
    expect(resolveCurrent([local, remote])).toBe(remote);
    expect(resolveCurrent([remote, local])).toBe(remote);
  });

  test('an unsynced local edit beyond the synced version shows immediately', () => {
    const local = version(3, null, { ml: 150 });
    expect(resolveCurrent([version(2, 50), local])).toBe(local);
  });

  test('every arrival order converges on the same winner', () => {
    const log = [
      version(1, 1),
      version(2, 5, { author: dad, ml: 80 }),
      version(2, 3, { author: mom, ml: 70 }),
      version(3, 9, { deleted: true }),
      version(3, 7, { ml: 100 }),
      version(3, null, { ml: 110 }),
    ];
    const winners = new Set(permutations(log).map((p) => resolveCurrent(p)));
    expect(winners.size).toBe(1);
    expect(resolveCurrent(log)?.seq).toBe(7);
  });

  test('tied unsynced versions resolve by content, not clock or property order', () => {
    const a = version(2, null, { notes: 'A', recordedAt: '2026-10-29T03:00:00.000Z' });
    const b = version(2, null, { notes: 'B', recordedAt: '2026-10-29T03:00:00.000Z' });
    const winner = resolveCurrent([a, b]);
    expect(resolveCurrent([b, a])).toBe(winner);

    // An earlier or later client clock on either side changes nothing.
    for (const recordedAt of ['2020-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z']) {
      const loserId = winner === a ? b : a;
      const skewed = { ...loserId, event: { ...loserId.event, recordedAt } };
      const other = winner === a ? a : b;
      expect(resolveCurrent([skewed, other])?.event.notes).toBe(other.event.notes);
    }

    // Rebuilding the winner with its properties in reverse order changes nothing.
    const w = winner as StoredVersion;
    const reordered = {
      seq: null,
      event: Object.fromEntries(Object.entries(w.event).reverse()) as typeof w.event,
    };
    const loser = winner === a ? b : a;
    expect(resolveCurrent([loser, reordered])?.event.notes).toBe(w.event.notes);
    expect(resolveCurrent([reordered, loser])?.event.notes).toBe(w.event.notes);
  });

  test('two bodies under one server seq are an integrity error', () => {
    const a = version(2, 7, { notes: 'A' });
    const b = version(2, 7, { notes: 'B' });
    expect(() => resolveCurrent([a, b])).toThrow(/Integrity error/);
    expect(resolveCurrent([a, { ...a, event: { ...a.event } }])?.seq).toBe(7);
  });

  test('rejects versions of different events', () => {
    const other = { seq: 2, event: { ...version(1, 2).event, id: newId() } };
    expect(() => resolveCurrent([version(1, 1), other])).toThrow(/versions of/);
  });
});

describe('canonicalJson', () => {
  test('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });
});

describe('compareVersions', () => {
  test('is antisymmetric and zero only for identical versions', () => {
    const vs = [version(1, 1), version(1, null), version(2, 2), version(2, 3), version(2, null)];
    for (const a of vs) {
      for (const b of vs) {
        expect(Math.sign(compareVersions(a, b)) + Math.sign(compareVersions(b, a))).toBe(0);
        if (a !== b) expect(compareVersions(a, b)).not.toBe(0);
      }
    }
  });
});

describe('resolveAll', () => {
  test('resolves each event independently', () => {
    const otherId = newId();
    const other1 = { seq: 2, event: { ...version(1, 2).event, id: otherId } };
    const other2 = { seq: 4, event: { ...version(2, 4).event, id: otherId } };
    const current = resolveAll([version(1, 1), other1, version(2, 3), other2]);
    expect(current.size).toBe(2);
    expect(current.get(id)?.seq).toBe(3);
    expect(current.get(otherId)).toBe(other2);
  });
});
