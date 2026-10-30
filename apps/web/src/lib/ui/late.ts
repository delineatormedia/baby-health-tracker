import type { BabyEvent, HouseholdDevice } from '@bht/schema';
import { merge, type Spans } from '../data/watermarks.ts';
import { isLogMark } from './logic.ts';

// Late uploads reopen windows (#5 step 3b, SYNC_PLAN "A returning phone"). Readings recomputes
// from the log on its own; what it cannot see is that an entry arrived after its window had
// been assessed. This tracks that: every span this phone has counted as covered by the other
// phones, and every entry from another phone that arrived dated inside one.

/** An entry from another phone that arrived dated where this phone already counted. */
export interface LateEntry {
  /** `${id}:${version}`: an edit that arrives late is late again. */
  key: string;
  authorId: string;
  /** occurredAt, ms. */
  at: number;
}

/** How long a late mark is kept: past every window Readings looks at. */
export const LATE_KEEP_MS = 30 * 86_400_000;
const MAX_LATE = 500;

export const versionKey = (e: BabyEvent) => `${e.id}:${e.version}`;

/**
 * `covered` with `spans` added, each cut off at `wall`: a span reaching into the future (a
 * removal's, or a vouch's open end) only counts for the time that has passed.
 */
export function cover(covered: Spans, spans: Spans, wall: number): Spans {
  return merge([...covered, ...spans.map(([s, e]): [number, number] => [s, Math.min(e, wall)])]);
}

/**
 * The entries in `events` that are not in `seen`, came from another phone, and are dated inside
 * a covered span. This phone's own writes and "We missed some" / "Count without" marks are
 * parents' statements, not late data, and never count.
 */
export function findLate(
  seen: ReadonlySet<string>,
  events: readonly BabyEvent[],
  covered: Spans,
  self: string,
): LateEntry[] {
  const out: LateEntry[] = [];
  for (const e of events) {
    if (e.authorId === self || isLogMark(e) || seen.has(versionKey(e))) continue;
    const at = Date.parse(e.occurredAt);
    if (covered.some(([s, end]) => s <= at && at <= end)) {
      out.push({ key: versionKey(e), authorId: e.authorId, at });
    }
  }
  return out;
}

/** The late entries dated inside the window [start, end] (ms). */
export function lateIn(late: readonly LateEntry[], start: number, end: number): LateEntry[] {
  return late.filter((l) => start <= l.at && l.at <= end);
}

/** "Updated: entries from Sam’s phone arrived late". */
export function lateText(
  late: readonly LateEntry[],
  devices: readonly HouseholdDevice[] | null,
): string {
  const names = [...new Set(late.map((l) => l.authorId))].map(
    (id) => devices?.find((d) => d.deviceId === id)?.memberName,
  );
  const known = [...new Set(names.filter((n): n is string => n !== undefined))];
  if (known.length === 0 || known.length < names.length) {
    return 'Updated: entries from another phone arrived late';
  }
  const list =
    known.length === 1 ? known[0] : `${known.slice(0, -1).join(', ')} and ${known.at(-1)}`;
  return `Updated: entries from ${list}’s phone${known.length === 1 ? '' : 's'} arrived late`;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

interface Saved {
  covered: Spans;
  late: LateEntry[];
}

const keyFor = (household: string) => `bht.late.${household}`;

/**
 * One household's late-arrival state, kept in localStorage so the first pull after a reload,
 * when a returning phone's backlog usually lands, is checked against what the last session
 * covered: the sample is in memory only, so the reloaded session covers nothing until its pull
 * is adopted. Writes merge with what is stored, so two tabs add to each other.
 */
export class LateTracker {
  #seen: Set<string> | null = null;
  #baby: string | null = null;
  #covered: Spans;
  #late: LateEntry[];

  constructor(
    readonly kv: KV,
    readonly household: string,
  ) {
    ({ covered: this.#covered, late: this.#late } = load(kv, household));
  }

  get late(): readonly LateEntry[] {
    return this.#late;
  }

  /** Adds what this phone counts as covered now. */
  record(spans: Spans, wall: number): void {
    this.#covered = cover(this.#covered, spans, wall);
    this.#save(wall);
  }

  /**
   * Called with every re-read of the log, before it replaces the one Readings shows, with the
   * spans Readings counted until now. The first read of a baby only sets what was seen.
   * Returns the entries newly found late.
   */
  observe(
    babyId: string,
    events: readonly BabyEvent[],
    spans: Spans,
    wall: number,
    self: string,
  ): LateEntry[] {
    this.#covered = cover(this.#covered, spans, wall);
    const found =
      this.#seen && this.#baby === babyId ? findLate(this.#seen, events, this.#covered, self) : [];
    this.#seen = new Set(events.map(versionKey));
    this.#baby = babyId;
    if (found.length > 0) this.#late = [...this.#late, ...found];
    this.#save(wall);
    return found;
  }

  #save(wall: number) {
    const stored = load(this.kv, this.household);
    const keys = new Set<string>();
    this.#covered = merge([...stored.covered, ...this.#covered]);
    this.#late = [...stored.late, ...this.#late]
      .filter((l) => !keys.has(l.key) && keys.add(l.key) && l.at >= wall - LATE_KEEP_MS)
      .slice(-MAX_LATE);
    try {
      this.kv.setItem(
        keyFor(this.household),
        JSON.stringify({
          covered: this.#covered.map(([s, e]) => [finite(s), finite(e)]),
          late: this.#late,
        }),
      );
    } catch (e) {
      // A full or blocked localStorage loses the note across reloads, never the data.
      console.error(e);
    }
  }
}

const finite = (n: number) => (Number.isFinite(n) ? n : null);

function load(kv: KV, household: string): Saved {
  let raw: unknown;
  try {
    raw = JSON.parse(kv.getItem(keyFor(household)) ?? 'null');
  } catch {
    raw = null;
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (x: unknown, inf: number) => (x === null ? inf : x);
  const covered = (Array.isArray(o.covered) ? o.covered : [])
    .filter((s): s is [unknown, unknown] => Array.isArray(s) && s.length === 2)
    .map(([s, e]): [unknown, unknown] => [num(s, -Infinity), num(e, Infinity)])
    .filter((s): s is [number, number] =>
      s.every((x) => typeof x === 'number' && !Number.isNaN(x)),
    );
  const late = (Array.isArray(o.late) ? o.late : []).filter(
    (l): l is LateEntry =>
      typeof l === 'object' &&
      l !== null &&
      typeof (l as LateEntry).key === 'string' &&
      typeof (l as LateEntry).authorId === 'string' &&
      Number.isFinite((l as LateEntry).at),
  );
  return { covered: merge(covered), late };
}
