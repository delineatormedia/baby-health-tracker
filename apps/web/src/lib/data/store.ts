import {
  canonicalJson,
  newId,
  nextVersion,
  parseEvent,
  resolveCurrent,
  type BabyEvent,
  type EventData,
  type EventType,
  type StoredVersion,
} from '@bht/schema';
import type { IDBPTransaction } from 'idb';
import { rowKey, type BhtDB, type Database, type VersionRow } from './db.ts';
import type { PullResponse, PushResult } from './protocol.ts';

export interface Change {
  event: BabyEvent;
  /** Reverts this change by writing a new version; resolves to the undo's own change. */
  undo: () => Promise<Change>;
}

export interface EditFields {
  data?: unknown;
  occurredAt?: string;
  notes?: string | null;
}

/**
 * The pull cursor's meta key. The cursor is a server-wide seq that only means something for
 * the household it was pulled from, so each household keeps its own: a phone that signs in to
 * another household starts that one at 0, and signing back in to the first resumes it.
 */
const cursorKey = (household: string) => (household ? `cursor:${household}` : 'cursor');

/**
 * Local-first event log in IndexedDB. Every write lands here first and is visible at once;
 * the sync client pushes pending versions and pulls everyone else's. The current state of an
 * event is resolveCurrent over all versions held, the same rule the server uses.
 */
export class EventStore {
  readonly #listeners = new Set<() => void>();
  readonly #localListeners = new Set<() => void>();

  constructor(
    readonly db: Database,
    /** Stamped on every write. Replaced when sign-in mints this phone a new device id. */
    public authorId: string,
    readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Current, non-deleted events for a baby, newest occurrence first. Each event id is resolved
   * over all of its rows before filtering by baby, so an entry moved to another baby never
   * shows under the old one from a stale row.
   */
  async events(babyId: string): Promise<BabyEvent[]> {
    const tx = this.db.transaction('versions');
    const ids = new Set((await tx.store.index('byBaby').getAll(babyId)).map((r) => r.id));
    const current: BabyEvent[] = [];
    for (const id of ids) {
      const event = resolveCurrent((await tx.store.index('byId').getAll(id)).map(toStored))?.event;
      if (event && event.babyId === babyId && !event.deleted) current.push(event);
    }
    await tx.done;
    return current.sort((a, b) =>
      a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
    );
  }

  /** Current version of one event, including a tombstone; undefined if never seen. */
  async current(id: string): Promise<BabyEvent | undefined> {
    return resolveCurrent((await this.#rows(id)).map(toStored))?.event;
  }

  async log<T extends EventType>(
    babyId: string,
    type: T,
    data: EventData<T>,
    opts: { occurredAt?: string; notes?: string | null } = {},
  ): Promise<Change> {
    const recordedAt = this.now().toISOString();
    const event = await this.#write({
      id: newId(),
      babyId,
      authorId: this.authorId,
      occurredAt: opts.occurredAt ?? recordedAt,
      recordedAt,
      version: 1,
      deleted: false,
      notes: opts.notes ?? null,
      type,
      data,
    });
    return { event, undo: () => this.remove(event.id) };
  }

  async edit(id: string, fields: EditFields): Promise<Change> {
    const { prev, event } = await this.#next(id, { ...fields, deleted: false });
    return { event, undo: () => this.#restore(prev) };
  }

  async remove(id: string): Promise<Change> {
    const { prev, event } = await this.#next(id, { deleted: true });
    return { event, undo: () => this.#restore(prev) };
  }

  /** Versions waiting to be pushed, oldest first: never a rejected or local-only row. */
  async pending(limit: number): Promise<BabyEvent[]> {
    const rows = await this.db.getAllFromIndex('versions', 'byPending', 1);
    return rows
      .filter((r) => r.rejected !== 1 && r.localOnly !== 1)
      .map((r) => r.event)
      .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0))
      .slice(0, limit);
  }

  /**
   * Records the server's verdict on the versions in `submitted`. Accepted, duplicate and
   * superseded versions are stored under their seq exactly as submitted. A rejected version
   * is never deleted: it stays on this phone marked rejected, is left out of uploads (retrying
   * cannot fix it) and is returned so the caller can surface it. A pending row is retired or
   * marked only if it still holds the submitted body; anything else stays pending.
   */
  async applyPushResults(submitted: BabyEvent[], results: PushResult[]): Promise<PushResult[]> {
    const sent = new Map(submitted.map((e) => [`${e.id}:${e.version}`, e]));
    const rejected: PushResult[] = [];
    const tx = this.db.transaction('versions', 'readwrite');
    for (const r of results) {
      const event = sent.get(`${r.id}:${r.version}`);
      if (!event) continue;
      const localKey = rowKey(event, null);
      const local = await tx.store.get(localKey);
      const unchanged = local !== undefined && canonicalJson(local.event) === canonicalJson(event);
      if (r.status === 'rejected') {
        if (unchanged) {
          await tx.store.put({ ...local, pending: 0, rejected: 1, rejectedError: r.error });
          rejected.push(r);
        }
        continue;
      }
      if (unchanged) await tx.store.delete(localKey);
      await tx.store.put({ ...toRow(event, r.seq), pending: 0 });
    }
    await tx.done;
    this.#emit();
    return rejected;
  }

  /** Stores pulled versions and advances `household`'s cursor in one transaction. */
  async applyPull(page: PullResponse, household = ''): Promise<void> {
    const tx = this.db.transaction(['versions', 'meta'], 'readwrite');
    const versions = tx.objectStore('versions');
    for (const { seq, event } of page.versions) await versions.put(toRow(event, seq));
    await tx.objectStore('meta').put(page.next, cursorKey(household));
    await tx.done;
    if (page.versions.length > 0) this.#emit();
  }

  /**
   * How many entries hold a refused version that no later synced version of the same entry
   * has replaced. Refused versions stay on this phone either way; once a later edit (from
   * here or another phone) reaches the server, that entry is no longer counted.
   */
  async rejectedCount(): Promise<number> {
    const tx = this.db.transaction('versions');
    const refused = await tx.store.index('byRejected').getAll(1);
    const open = new Set<string>();
    for (const r of refused) {
      if (open.has(r.id)) continue;
      const rows = await tx.store.index('byId').getAll(r.id);
      if (!rows.some((o) => o.seq !== null && o.event.version > r.event.version)) open.add(r.id);
    }
    await tx.done;
    return open.size;
  }

  /**
   * Joining a household whose baby is `to`: re-keys every entry whose current version is under
   * `from`, in one transaction. Each moves as a new version (one above every version held)
   * with the new babyId, so a tombstone stays deleted and an edit moves as its latest body.
   * Every earlier row of a moved id becomes localOnly. An entry already under `to` is left
   * alone, so running it again after a commit moves nothing. Resolves to the number moved.
   * Any failure aborts the whole move.
   */
  async moveBaby(from: string, to: string): Promise<number> {
    const tx = this.db.transaction('versions', 'readwrite');
    const recordedAt = this.now().toISOString();
    let moved = 0;
    try {
      const ids = new Set((await tx.store.index('byBaby').getAll(from)).map((r) => r.id));
      for (const id of ids) {
        const rows = await tx.store.index('byId').getAll(id);
        const current = resolveCurrent(rows.map(toStored))?.event;
        if (!current || current.babyId !== from) continue;
        const parsed = parseEvent({
          ...current,
          babyId: to,
          authorId: this.authorId,
          recordedAt,
          version: nextVersion(Math.max(...rows.map((r) => r.event.version))),
        });
        if (!parsed.ok) throw new Error(`Cannot move ${id}: ${parsed.errors.join('; ')}`);
        for (const r of rows) await tx.store.put({ ...r, pending: 0, localOnly: 1 });
        await tx.store.add({ ...toRow(parsed.value, null), pending: 1 });
        moved += 1;
      }
    } catch (e) {
      tx.abort();
      await tx.done.catch(() => {});
      throw e;
    }
    await tx.done;
    this.#emit(true);
    return moved;
  }

  /**
   * Joining a household without this phone's baby: every row of `from` becomes localOnly and
   * archived, in one transaction. Nothing is deleted and nothing is uploaded; History can
   * still show the archived baby read-only.
   */
  async archiveBaby(from: string): Promise<void> {
    const tx = this.db.transaction('versions', 'readwrite');
    for (const r of await tx.store.index('byBaby').getAll(from)) {
      await tx.store.put({ ...r, pending: 0, localOnly: 1, archived: 1 });
    }
    await tx.done;
    this.#emit();
  }

  async cursor(household = ''): Promise<number> {
    return (await this.db.get('meta', cursorKey(household))) ?? 0;
  }

  /** Forgets how far this phone has pulled from `household`. Called at sign-out. */
  async resetCursor(household = ''): Promise<void> {
    await this.db.delete('meta', cursorKey(household));
  }

  /**
   * Whether this phone holds any row for `babyId`: a visible entry, a tombstone, a pending,
   * refused or local-only version. Placement at sign-in asks by this, not by visible entries,
   * so an undone entry's versions are never uploaded under a household that lacks the baby.
   */
  async hasRows(babyId: string): Promise<boolean> {
    return (await this.db.countFromIndex('versions', 'byBaby', babyId)) > 0;
  }

  /** Whether any entry of `babyId` reached a server, by this phone's push or a pull. */
  async hasSynced(babyId: string): Promise<boolean> {
    const rows = await this.db.getAllFromIndex('versions', 'byBaby', babyId);
    return rows.some((r) => r.seq !== null);
  }

  /** Called after every local write or sync change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Called after local writes only (the sync client's trigger). */
  subscribeLocal(listener: () => void): () => void {
    this.#localListeners.add(listener);
    return () => this.#localListeners.delete(listener);
  }

  #emit(local = false) {
    for (const l of this.#listeners) l();
    if (local) for (const l of this.#localListeners) l();
  }

  #rows(id: string): Promise<VersionRow[]> {
    return this.db.getAllFromIndex('versions', 'byId', id);
  }

  /**
   * Writes the next version of an event on top of its current version. Reading the versions
   * held and appending happen in one readwrite transaction, which IndexedDB serializes across
   * every connection, so concurrent writers (in this store or another tab) each get their own
   * number above every version held, won or lost, and never overwrite each other.
   */
  async #next(
    id: string,
    fields: EditFields & { deleted: boolean },
  ): Promise<{ prev: BabyEvent; event: BabyEvent }> {
    const tx = this.db.transaction('versions', 'readwrite');
    const rows = await tx.store.index('byId').getAll(id);
    const prev = resolveCurrent(rows.map(toStored))?.event;
    if (!prev) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new Error(`Unknown event ${id}`);
    }
    const event = await this.#append(tx, {
      ...prev,
      ...fields,
      authorId: this.authorId,
      recordedAt: this.now().toISOString(),
      version: nextVersion(Math.max(...rows.map((r) => r.event.version))),
    });
    return { prev, event };
  }

  async #restore(prev: BabyEvent): Promise<Change> {
    const { data, occurredAt, notes, deleted } = prev;
    const { prev: before, event } = await this.#next(prev.id, { data, occurredAt, notes, deleted });
    return { event, undo: () => this.#restore(before) };
  }

  #write(candidate: unknown): Promise<BabyEvent> {
    return this.#append(this.db.transaction('versions', 'readwrite'), candidate);
  }

  /** Adds a pending version and commits `tx`. `add` refuses to replace an existing row. */
  async #append(tx: VersionsTx, candidate: unknown): Promise<BabyEvent> {
    const parsed = parseEvent(candidate);
    if (!parsed.ok) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new Error(`Invalid event: ${parsed.errors.join('; ')}`);
    }
    const event = parsed.value;
    await tx.store.add({ ...toRow(event, null), pending: 1 });
    await tx.done;
    this.#emit(true);
    return event;
  }
}

type VersionsTx = IDBPTransaction<BhtDB, ['versions'], 'readwrite'>;

function toRow(event: BabyEvent, seq: number | null): VersionRow {
  return { key: rowKey(event, seq), id: event.id, babyId: event.babyId, seq, pending: 0, event };
}

function toStored(row: VersionRow): StoredVersion {
  return { seq: row.seq, event: row.event };
}
