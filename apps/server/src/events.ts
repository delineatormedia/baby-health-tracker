import {
  canonicalJson,
  parseEvent,
  resolveCurrent,
  type BabyEvent,
  type PullResponse,
  type PushResult,
} from '@bht/schema';
import type { DatabaseSync } from 'node:sqlite';
import type { Session } from './auth.ts';

/**
 * Stores pushed versions for one household in a single transaction and returns a verdict
 * for each, in order. Each version is validated with the shared schema. An identical body
 * already held is a duplicate under its original seq; any other valid body gets the next seq,
 * and is superseded if resolveCurrent over that event's versions does not pick it. An event
 * id already held by another household is refused without saying so, and so is a babyId that
 * is not one of this household's babies. Each stored version records the member who pushed it.
 */
export function pushVersions(
  db: DatabaseSync,
  session: Session,
  inputs: readonly unknown[],
  now = new Date(),
): PushResult[] {
  const { householdId } = session;
  const memberId = session.memberId ?? null;
  const babies = new Set(
    (
      db.prepare('SELECT id FROM babies WHERE household_id = ?').all(householdId) as {
        id: string;
      }[]
    ).map((r) => r.id),
  );
  const owner = db.prepare('SELECT household_id FROM event_versions WHERE event_id = ? LIMIT 1');
  const existing = db.prepare(
    'SELECT seq FROM event_versions WHERE event_id = ? AND version = ? AND body = ?',
  );
  const insert = db.prepare(
    `INSERT INTO event_versions
       (household_id, event_id, version, baby_id, body, received_at, member_id)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
  );
  const versions = db.prepare('SELECT seq, body FROM event_versions WHERE event_id = ?');
  const receivedAt = now.toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const results = inputs.map((input): PushResult => {
      const parsed = parseEvent(input);
      if (!parsed.ok) return rejected(input, parsed.errors.join('; '));
      const event = parsed.value;
      const held = owner.get(event.id) as { household_id: string } | undefined;
      if (held && held.household_id !== householdId) return rejected(input, 'Unknown event');
      if (!babies.has(event.babyId)) return rejected(input, 'Unknown baby');
      const body = canonicalJson(event);
      const dup = existing.get(event.id, event.version, body) as { seq: number } | undefined;
      if (dup) return verdict(event, dup.seq, 'duplicate');
      const { seq } = insert.get(
        householdId,
        event.id,
        event.version,
        event.babyId,
        body,
        receivedAt,
        memberId,
      ) as { seq: number };
      const all = (versions.all(event.id) as { seq: number; body: string }[]).map((r) => ({
        seq: r.seq,
        event: JSON.parse(r.body) as BabyEvent,
      }));
      const winner = resolveCurrent(all);
      return verdict(event, seq, winner?.seq === seq ? 'accepted' : 'superseded');
    });
    db.exec('COMMIT');
    return results;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * One page of the household's versions after `after` and up to `through`, in seq order, at
 * most `limit` of them. The page is read in one transaction, so WAL gives it a fixed snapshot.
 * On a pull's first page `through` is null, and it is set to the household's highest seq in
 * that snapshot; later pages pass it back, so versions pushed mid-pull wait for the next pull.
 */
export function pullVersions(
  db: DatabaseSync,
  householdId: string,
  page: { after: number; limit: number; through: number | null },
): PullResponse {
  const { after, limit } = page;
  db.exec('BEGIN');
  try {
    const through =
      page.through ??
      (
        db
          .prepare('SELECT coalesce(max(seq), 0) AS top FROM event_versions WHERE household_id = ?')
          .get(householdId) as { top: number }
      ).top;
    const rows = db
      .prepare(
        `SELECT seq, body FROM event_versions
         WHERE household_id = ? AND seq > ? AND seq <= ?
         ORDER BY seq LIMIT ?`,
      )
      .all(householdId, after, through, limit + 1) as { seq: number; body: string }[];
    db.exec('COMMIT');
    const versions = rows.slice(0, limit);
    return {
      versions: versions.map((r) => ({ seq: r.seq, event: JSON.parse(r.body) as BabyEvent })),
      next: versions.at(-1)?.seq ?? after,
      more: rows.length > limit,
      through,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function verdict(
  event: BabyEvent,
  seq: number,
  status: 'accepted' | 'duplicate' | 'superseded',
): PushResult {
  return { id: event.id, version: event.version, seq, status };
}

function rejected(input: unknown, error: string): PushResult {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    id?: unknown;
    version?: unknown;
  };
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    version: typeof raw.version === 'number' ? raw.version : 0,
    status: 'rejected',
    error,
  };
}
