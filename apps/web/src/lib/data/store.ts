import {
  newId,
  nextVersion,
  parseEvent,
  resolveAll,
  resolveCurrent,
  type BabyEvent,
  type EventData,
  type EventType,
  type StoredVersion,
} from '@bht/schema';
import { rowKey, type Database, type VersionRow } from './db.ts';
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

const CURSOR = 'cursor';

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
    readonly authorId: string,
    readonly now: () => Date = () => new Date(),
  ) {}

  /** Current, non-deleted events for a baby, newest occurrence first. */
  async events(babyId: string): Promise<BabyEvent[]> {
    const rows = await this.db.getAllFromIndex('versions', 'byBaby', babyId);
    return [...resolveAll(rows.map(toStored)).values()]
      .map((v) => v.event)
      .filter((e) => !e.deleted)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
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
    const prev = await this.#require(id);
    const event = await this.#next(prev, { ...fields, deleted: false });
    return { event, undo: () => this.#restore(prev) };
  }

  async remove(id: string): Promise<Change> {
    const prev = await this.#require(id);
    const event = await this.#next(prev, { deleted: true });
    return { event, undo: () => this.#restore(prev) };
  }

  /** Versions waiting to be pushed, oldest first. */
  async pending(limit: number): Promise<BabyEvent[]> {
    const rows = await this.db.getAllFromIndex('versions', 'byPending', 1);
    return rows
      .map((r) => r.event)
      .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0))
      .slice(0, limit);
  }

  /**
   * Records the server's verdict on pushed versions. Accepted, duplicate and superseded
   * versions are kept under their seq. Rejected ones are dropped (retrying cannot fix them)
   * and returned so the caller can surface them.
   */
  async applyPushResults(results: PushResult[]): Promise<PushResult[]> {
    const rejected: PushResult[] = [];
    const tx = this.db.transaction('versions', 'readwrite');
    for (const r of results) {
      const localKey = `${r.id}:${r.version}:local`;
      const local = await tx.store.get(localKey);
      if (!local) continue;
      await tx.store.delete(localKey);
      if (r.status === 'rejected') {
        rejected.push(r);
        continue;
      }
      await tx.store.put({ ...local, key: rowKey(local.event, r.seq), seq: r.seq, pending: 0 });
    }
    await tx.done;
    this.#emit();
    return rejected;
  }

  /** Stores pulled versions and advances the cursor in one transaction. */
  async applyPull(page: PullResponse): Promise<void> {
    const tx = this.db.transaction(['versions', 'meta'], 'readwrite');
    const versions = tx.objectStore('versions');
    for (const { seq, event } of page.versions) {
      await versions.put({
        key: rowKey(event, seq),
        id: event.id,
        babyId: event.babyId,
        seq,
        pending: 0,
        event,
      });
    }
    await tx.objectStore('meta').put(page.next, CURSOR);
    await tx.done;
    if (page.versions.length > 0) this.#emit();
  }

  async cursor(): Promise<number> {
    return (await this.db.get('meta', CURSOR)) ?? 0;
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

  async #require(id: string): Promise<BabyEvent> {
    const current = await this.current(id);
    if (!current) throw new Error(`Unknown event ${id}`);
    return current;
  }

  /** Writes the next version of an event; the number is above every version held, won or lost. */
  async #next(prev: BabyEvent, fields: EditFields & { deleted: boolean }): Promise<BabyEvent> {
    const highest = Math.max(...(await this.#rows(prev.id)).map((r) => r.event.version));
    return this.#write({
      ...prev,
      ...fields,
      authorId: this.authorId,
      recordedAt: this.now().toISOString(),
      version: nextVersion(highest),
    });
  }

  async #restore(prev: BabyEvent): Promise<Change> {
    const before = await this.#require(prev.id);
    const { data, occurredAt, notes, deleted } = prev;
    const event = await this.#next(prev, { data, occurredAt, notes, deleted });
    return { event, undo: () => this.#restore(before) };
  }

  async #write(candidate: unknown): Promise<BabyEvent> {
    const parsed = parseEvent(candidate);
    if (!parsed.ok) throw new Error(`Invalid event: ${parsed.errors.join('; ')}`);
    const event = parsed.value;
    await this.db.put('versions', {
      key: rowKey(event, null),
      id: event.id,
      babyId: event.babyId,
      seq: null,
      pending: 1,
      event,
    });
    this.#emit(true);
    return event;
  }
}

function toStored(row: VersionRow): StoredVersion {
  return { seq: row.seq, event: row.event };
}
