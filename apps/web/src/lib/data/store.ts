import {
  canonicalJson,
  idTime,
  newId,
  nextVersion,
  parseEvent,
  resolveCurrent,
  type BabyEvent,
  type EventData,
  type EventType,
  type HouseholdDevice,
  type StoredVersion,
} from '@bht/schema';
import type { IDBPTransaction } from 'idb';
import {
  rowKey,
  type BabyMark,
  type BhtDB,
  type ClearMark,
  type Database,
  type PendingWipe,
  type VersionRow,
} from './db.ts';
import type { ClearId, PullResponse, PushResult } from './protocol.ts';

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
const devicesKey = (household: string) => `devices:${household}`;
/** The household's clear marker as this phone holds it (#85); see ClearMark in db.ts. */
const clearKey = (household: string) => `clear:${household}`;
/** A wipe whose localStorage side is still to run (#85); see PendingWipe in db.ts. */
const wipeKey = (household: string) => `wipe:${household}`;
/** Every household's pending wipe, whichever account the phone is under now (#95). */
const wipeKeys = () => IDBKeyRange.bound(wipeKey(''), wipeKey('￿'));
/** The generation a baby this phone holds was taken under (#95); see BabyMark in db.ts. */
const babyKey = (babyId: string) => `baby:${babyId}`;

/**
 * The clear marker a request was sent under (#85): what clearMark() returned just before it
 * went out, so null when the phone held none. A store write that lands a response checks the
 * marker again in its own transaction; see MarkerMoved.
 */
export type SentMark = ClearMark | null;

/**
 * A response's store write refused because the household's marker changed while the request
 * was out: another tab cleared the household's data (#85), and what the response carries is
 * from before the clear. Nothing was written. The sync run goes round again under the marker
 * the store holds now.
 */
export class MarkerMoved extends Error {
  override name = 'MarkerMoved';
  constructor() {
    super('The household’s data was cleared while this request was out');
  }
}

/**
 * Whether `held`, the marker in the store now, is the one the request was sent under. A view
 * from a server without markers leaves the field undefined; that is null, "no clear yet".
 */
const sameMark = (held: ClearMark | undefined, under: SentMark) =>
  held === undefined
    ? under === null
    : under !== null && (held.clearId ?? null) === (under.clearId ?? null);

/**
 * The write generation's meta key (step 3b). Every local write bumps it in the transaction that
 * adds its row. All tabs share one IndexedDB, so they share the counter: a barrier that reads
 * gen G with the pending rows covers every write numbered G or below.
 */
const GEN_KEY = 'gen';

/**
 * Set while this phone signs out (step 3b). Every local write reads it in the transaction that
 * would bump `gen`, and aborts if it is set, so the write barrier's snapshot holds every write
 * the phone makes as this device.
 */
const SIGNING_OUT_KEY = 'signingOut';

/** A local write refused because this phone is signing out, in this tab or another. */
export class SigningOut extends Error {
  override name = 'SigningOut';
  constructor() {
    super('This phone is signing out');
  }
}

/**
 * A local write refused because a wipe is still pending (#85, #97): the household's data was
 * cleared and IndexedDB dropped its copy, but the localStorage side has not run yet, so the
 * screens still show the erased baby. An entry logged now would belong to a baby the server no
 * longer has and would sit refused on this phone for good, so it is refused up front, in the
 * transaction that would add it. Writes resume once the wipe is finished (wipeDone).
 */
export class WipePending extends Error {
  override name = 'WipePending';
  constructor() {
    super('This phone is still dropping the household’s cleared data');
  }
}

/**
 * A local write refused because its baby went with a clear (#95): the baby was taken under an
 * earlier marker than the one the household holds now (see BabyMark). The wipe that moved the
 * marker, in this tab or another, dropped the stored baby; this tab was still showing it. The
 * check is in the write's own transaction, so it holds whether or not the other tab's
 * broadcast has arrived, and after the wipe's pending record is gone.
 */
export class BabyCleared extends Error {
  override name = 'BabyCleared';
  constructor() {
    super('This baby went with the household’s cleared data');
  }
}

/** The pending rows, write generation and clear marker read in one transaction, for a barrier. */
export interface Snapshot {
  gen: number;
  pending: BabyEvent[];
  /** The household's marker as held with these rows: the one the barrier must carry (#85). */
  under: SentMark;
}

/**
 * Local-first event log in IndexedDB. Every write lands here first and is visible at once;
 * the sync client pushes pending versions and pulls everyone else's. The current state of an
 * event is resolveCurrent over all versions held, the same rule the server uses.
 */
export class EventStore {
  readonly #listeners = new Set<() => void>();
  readonly #localListeners = new Set<() => void>();
  /** Writes started and not yet settled; a page load now would lose them (#74). */
  #writes = 0;

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

  log<T extends EventType>(
    babyId: string,
    type: T,
    data: EventData<T>,
    opts: { occurredAt?: string; notes?: string | null } = {},
  ): Promise<Change> {
    return this.track(() => this.#log(babyId, type, data, opts));
  }

  async #log<T extends EventType>(
    babyId: string,
    type: T,
    data: EventData<T>,
    opts: { occurredAt?: string; notes?: string | null },
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

  edit(id: string, fields: EditFields): Promise<Change> {
    return this.track(async () => {
      const { prev, event } = await this.#next(id, { ...fields, deleted: false });
      return { event, undo: () => this.#restore(prev) };
    });
  }

  remove(id: string): Promise<Change> {
    return this.track(async () => {
      const { prev, event } = await this.#next(id, { deleted: true });
      return { event, undo: () => this.#restore(prev) };
    });
  }

  /** Whether a write has started and not yet settled. */
  get writing(): boolean {
    return this.#writes > 0;
  }

  /**
   * Counts `run` as a write in flight from this call until it settles. The count goes up before
   * `run` starts, so a caller can clear whatever showed the work as pending (a Retry banner)
   * inside `run` with no moment where neither shows (#74).
   */
  track<T>(run: () => Promise<T>): Promise<T> {
    this.#writes++;
    const done = () => void this.#writes--;
    let p: Promise<T>;
    try {
      p = run();
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(done, done);
    return p;
  }

  /** Versions waiting to be pushed, oldest first: never a rejected or local-only row. */
  async pending(limit: number): Promise<BabyEvent[]> {
    return uploadable(await this.db.getAllFromIndex('versions', 'byPending', 1)).slice(0, limit);
  }

  /**
   * The write generation, every version waiting to be pushed and `household`'s clear marker,
   * read in one transaction. A write that commits after it has a higher gen, so a barrier for
   * this snapshot never claims it; a clear that commits after it changes the marker, so a
   * barrier carrying this snapshot's is refused rather than vouching for rows that are gone.
   * Pushes read their batches the same way (#85): a batch and the marker it goes up under
   * come from one read, so a clear between them cannot send cleared rows under its new marker.
   */
  async snapshot(household = ''): Promise<Snapshot> {
    const tx = this.db.transaction(['versions', 'meta']);
    const meta = tx.objectStore('meta');
    const gen = ((await meta.get(GEN_KEY)) as number | undefined) ?? 0;
    const under = ((await meta.get(clearKey(household))) as ClearMark | undefined) ?? null;
    const rows = await tx.objectStore('versions').index('byPending').getAll(1);
    await tx.done;
    return { gen, pending: uploadable(rows), under };
  }

  /** Whether the server has answered for every version in `events`: none is still pending. */
  async acknowledged(events: readonly BabyEvent[]): Promise<boolean> {
    const tx = this.db.transaction('versions');
    let all = true;
    for (const e of events) {
      const row = await tx.store.get(rowKey(e, null));
      if (row && row.pending === 1) all = false;
    }
    await tx.done;
    return all;
  }

  /** The device list last adopted from `household`'s pulls; null before the first. */
  async devices(household: string): Promise<HouseholdDevice[] | null> {
    return ((await this.db.get('meta', devicesKey(household))) as HouseholdDevice[]) ?? null;
  }

  /**
   * Records the server's verdict on the versions in `submitted`. Accepted, duplicate and
   * superseded versions are stored under their seq exactly as submitted. A rejected version
   * is never deleted: it stays on this phone marked rejected, is left out of uploads (retrying
   * cannot fix it) and is returned so the caller can surface it. A pending row is retired or
   * marked only if it still holds the submitted body; anything else stays pending. Given the
   * marker the push was sent `under`, writes nothing and throws MarkerMoved if `household`'s
   * marker has changed since: the versions were cleared while the push was out (#85).
   */
  applyPushResults(
    submitted: BabyEvent[],
    results: PushResult[],
    household = '',
    under?: SentMark,
  ): Promise<PushResult[]> {
    return this.track(() => this.#applyPushResults(submitted, results, household, under));
  }

  async #applyPushResults(
    submitted: BabyEvent[],
    results: PushResult[],
    household: string,
    under: SentMark | undefined,
  ): Promise<PushResult[]> {
    const sent = new Map(submitted.map((e) => [`${e.id}:${e.version}`, e]));
    const rejected: PushResult[] = [];
    const tx = this.db.transaction(['versions', 'meta'], 'readwrite');
    await this.#checkMark(tx, household, under);
    const versions = tx.objectStore('versions');
    for (const r of results) {
      const event = sent.get(`${r.id}:${r.version}`);
      if (!event) continue;
      const localKey = rowKey(event, null);
      const local = await versions.get(localKey);
      const unchanged = local !== undefined && canonicalJson(local.event) === canonicalJson(event);
      if (r.status === 'rejected') {
        if (unchanged) {
          await versions.put({ ...local, pending: 0, rejected: 1, rejectedError: r.error });
          rejected.push(r);
        }
        continue;
      }
      if (unchanged) await versions.delete(localKey);
      await versions.put({ ...toRow(event, r.seq), pending: 0 });
    }
    await tx.done;
    this.#emit();
    return rejected;
  }

  /**
   * Stores pulled versions and advances `household`'s cursor in one transaction. `devices` is
   * the list from the pull's first page: it is adopted here, with the page that reaches
   * through, so an interrupted pull adopts nothing (step 3b). Given the marker the pull was
   * sent `under`, writes nothing and throws MarkerMoved if the household's marker has changed
   * since: the page is from before a clear, and storing it would bring the cleared rows back.
   */
  applyPull(
    page: PullResponse,
    household = '',
    devices?: HouseholdDevice[],
    under?: SentMark,
  ): Promise<void> {
    return this.track(() => this.#applyPull(page, household, devices, under));
  }

  async #applyPull(
    page: PullResponse,
    household: string,
    devices: HouseholdDevice[] | undefined,
    under: SentMark | undefined,
  ): Promise<void> {
    const tx = this.db.transaction(['versions', 'meta'], 'readwrite');
    await this.#checkMark(tx, household, under);
    const versions = tx.objectStore('versions');
    for (const { seq, event } of page.versions) await versions.put(toRow(event, seq));
    const meta = tx.objectStore('meta');
    await meta.put(page.next, cursorKey(household));
    if (devices && !page.more) await meta.put(devices, devicesKey(household));
    // A phone from before #85 holds no marker; the first page's is the one its request was
    // accepted under, so adopting it drops nothing.
    if (page.clearId !== undefined && (await meta.get(clearKey(household))) === undefined) {
      await meta.put({ clearId: page.clearId } satisfies ClearMark, clearKey(household));
    }
    await tx.done;
    if (page.versions.length > 0) this.#emit();
  }

  /**
   * Inside a write transaction that lands a response: throws MarkerMoved, before any write, if
   * `household`'s marker is no longer the one the request went out under (#85). Skipped when
   * the caller sent no marker to compare, as the store's own tests do.
   */
  async #checkMark(tx: WriteTx, household: string, under: SentMark | undefined): Promise<void> {
    if (under === undefined) return;
    const held = (await tx.objectStore('meta').get(clearKey(household))) as ClearMark | undefined;
    if (!sameMark(held, under)) throw new MarkerMoved();
  }

  /** The household's clear marker as this phone holds it (#85), or null while it holds none. */
  async clearMark(household: string): Promise<ClearMark | null> {
    return ((await this.db.get('meta', clearKey(household))) as ClearMark | undefined) ?? null;
  }

  /** A wipe whose localStorage side is still to run (#85), or null; see PendingWipe. */
  async pendingWipe(household: string): Promise<PendingWipe | null> {
    return ((await this.db.get('meta', wipeKey(household))) as PendingWipe | undefined) ?? null;
  }

  /**
   * Every wipe whose localStorage side is still to run, whichever household it belongs to
   * (#95): the record stops every local write, so repair must find it under any account, or
   * none. Each comes with the household its key names.
   */
  async pendingWipes(): Promise<{ household: string; wipe: PendingWipe }[]> {
    const tx = this.db.transaction('meta');
    const keys = await tx.store.getAllKeys(wipeKeys());
    const wipes = (await tx.store.getAll(wipeKeys())) as PendingWipe[];
    await tx.done;
    return keys.map((key, i) => ({
      household: String(key).slice(wipeKey('').length),
      wipe: wipes[i]!,
    }));
  }

  /** Records that the localStorage side of `household`'s last wipe is done (#85). */
  async wipeDone(household: string): Promise<void> {
    await this.db.delete('meta', wipeKey(household));
  }

  /** The generation `babyId` was taken under (#95), or null if this phone never took it. */
  async babyMark(babyId: string): Promise<BabyMark | null> {
    return ((await this.db.get('meta', babyKey(babyId))) as BabyMark | undefined) ?? null;
  }

  /**
   * Records `babyId` as held under `household`'s current marker (#95; see BabyMark): from here
   * every local write for the baby is refused once the marker moves. Given the marker the
   * baby was read `under` (the household view it came from), writes nothing and throws
   * MarkerMoved if the household's marker has changed since: the baby is from before a clear,
   * and holding it would leave an erased baby on screen. Null, for a phone with no record yet,
   * matches an absent one and marks the baby under null (see refuseWhileStopped). Left
   * undefined, for a baby added on this phone, the baby takes whatever generation is current:
   * it is new under any.
   */
  async takeBaby(babyId: string, household: string, under?: SentMark): Promise<BabyMark> {
    const tx = this.db.transaction('meta', 'readwrite');
    const held = (await tx.store.get(clearKey(household))) as ClearMark | undefined;
    if (under !== undefined && !sameMark(held, under)) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new MarkerMoved();
    }
    const mark: BabyMark = { household, clearId: held?.clearId ?? null };
    await tx.store.put(mark, babyKey(babyId));
    await tx.done;
    return mark;
  }

  /**
   * Takes `clearId` as the household's marker without dropping anything: for a phone placed in
   * the household for the first time, whose own data was never the household's.
   */
  async adoptClear(household: string, clearId: ClearId): Promise<void> {
    await this.db.put('meta', { clearId } satisfies ClearMark, clearKey(household));
  }

  /**
   * The local side of a clear (#85): every stored version goes, pending, refused, local-only
   * and archived rows included, with the household's cursor and device list, and `clearId`
   * is recorded as the marker, all in one transaction. So either this phone holds the new
   * marker and nothing else, or it still holds everything and the stale marker, and the next
   * sync is refused and tries again. Nothing is uploaded first: entries the phone never synced
   * are dropped too, as the owner decided. The sign-out flag does not apply: this is not a
   * write the barrier has to cover. The same transaction records the wipe as pending, for the
   * localStorage side the caller runs next (see wipeDone); the record is returned.
   */
  clearAll(household: string, clearId: ClearId): Promise<PendingWipe> {
    return this.track(() => this.#clearAll(household, clearId));
  }

  async #clearAll(household: string, clearId: ClearId): Promise<PendingWipe> {
    const wipe: PendingWipe = { clearId, at: clearId ? idTime(clearId) : this.now().getTime() };
    const tx = this.db.transaction(['versions', 'meta'], 'readwrite');
    const meta = tx.objectStore('meta');
    await tx.objectStore('versions').clear();
    await meta.delete(cursorKey(household));
    await meta.delete(devicesKey(household));
    await meta.put({ clearId } satisfies ClearMark, clearKey(household));
    await meta.put(wipe, wipeKey(household));
    await tx.done;
    this.#emit();
    return wipe;
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
  moveBaby(from: string, to: string): Promise<number> {
    return this.track(() => this.#moveBaby(from, to));
  }

  async #moveBaby(from: string, to: string): Promise<number> {
    const tx = this.db.transaction(['versions', 'meta'], 'readwrite');
    const store = tx.objectStore('versions');
    const recordedAt = this.now().toISOString();
    let moved = 0;
    try {
      await refuseWhileStopped(tx, to);
      const ids = new Set((await store.index('byBaby').getAll(from)).map((r) => r.id));
      for (const id of ids) {
        const rows = await store.index('byId').getAll(id);
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
        for (const r of rows) await store.put({ ...r, pending: 0, localOnly: 1 });
        await store.add({ ...toRow(parsed.value, null), pending: 1 });
        moved += 1;
      }
      if (moved > 0) await bumpGen(tx);
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
  archiveBaby(from: string): Promise<void> {
    return this.track(() => this.#archiveBaby(from));
  }

  async #archiveBaby(from: string): Promise<void> {
    const tx = this.db.transaction('versions', 'readwrite');
    for (const r of await tx.store.index('byBaby').getAll(from)) {
      await tx.store.put({ ...r, pending: 0, localOnly: 1, archived: 1 });
    }
    await tx.done;
    this.#emit();
  }

  async cursor(household = ''): Promise<number> {
    return ((await this.db.get('meta', cursorKey(household))) as number | undefined) ?? 0;
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

  /**
   * Stops local writes for sign-out, in every tab. Resolves once the flag has committed: a
   * write that started earlier has committed first, and every later one aborts.
   */
  async beginSignOut(): Promise<void> {
    await this.db.put('meta', 1, SIGNING_OUT_KEY);
  }

  /** Lets local writes resume, after sign-out finishes or is cancelled. */
  async endSignOut(): Promise<void> {
    await this.db.delete('meta', SIGNING_OUT_KEY);
  }

  async signingOut(): Promise<boolean> {
    return (await this.db.get('meta', SIGNING_OUT_KEY)) !== undefined;
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
    const tx = this.db.transaction(['versions', 'meta'], 'readwrite');
    const rows = await tx.objectStore('versions').index('byId').getAll(id);
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

  #restore(prev: BabyEvent): Promise<Change> {
    return this.track(async () => {
      const { data, occurredAt, notes, deleted } = prev;
      const { prev: before, event } = await this.#next(prev.id, {
        data,
        occurredAt,
        notes,
        deleted,
      });
      return { event, undo: () => this.#restore(before) };
    });
  }

  #write(candidate: unknown): Promise<BabyEvent> {
    return this.#append(this.db.transaction(['versions', 'meta'], 'readwrite'), candidate);
  }

  /**
   * Adds a pending version, bumps the write generation and commits `tx`. `add` refuses to
   * replace an existing row.
   */
  async #append(tx: WriteTx, candidate: unknown): Promise<BabyEvent> {
    const parsed = parseEvent(candidate);
    if (!parsed.ok) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new Error(`Invalid event: ${parsed.errors.join('; ')}`);
    }
    const event = parsed.value;
    try {
      await refuseWhileStopped(tx, event.babyId);
    } catch (e) {
      tx.abort();
      await tx.done.catch(() => {});
      throw e;
    }
    await tx.objectStore('versions').add({ ...toRow(event, null), pending: 1 });
    await bumpGen(tx);
    await tx.done;
    this.#emit(true);
    return event;
  }
}

type WriteTx = IDBPTransaction<BhtDB, ['versions', 'meta'], 'readwrite'>;

/**
 * Throws SigningOut if the flag is set, WipePending if any household's wipe is still to finish
 * (#97), or BabyCleared if `babyId` was taken under a marker its household no longer holds
 * (#95); the caller aborts `tx`. All three are read in the write's own transaction, so a write
 * that opened before the flag, the wipe record or the new marker committed lands first, and
 * every later one is refused. The wipe record is keyed by household, and a phone mid-wipe has
 * no baby a write could rightly belong to, so any record refuses. The baby's mark is the
 * durable check: it outlives the wipe record, and needs no word from the tab that cleared.
 * A baby this phone never took under a household (one set up offline) has no mark to fail.
 */
async function refuseWhileStopped(tx: WriteTx, babyId: string): Promise<void> {
  const meta = tx.objectStore('meta');
  if ((await meta.get(SIGNING_OUT_KEY)) !== undefined) throw new SigningOut();
  if ((await meta.count(wipeKeys())) > 0) throw new WipePending();
  const mark = (await meta.get(babyKey(babyId))) as BabyMark | undefined;
  if (!mark) return;
  const held = (await meta.get(clearKey(mark.household))) as ClearMark | undefined;
  // A phone with no clear record yet (one from before #85 whose first sync is still to adopt
  // the server's marker) holds the null generation: the server treats a request without a
  // marker as sent under null, so null is the only marker its first page can bring, and the
  // one its baby was marked under at startup. An absent record is not a moved marker here.
  if ((held?.clearId ?? null) !== mark.clearId) throw new BabyCleared();
}

async function bumpGen(tx: WriteTx): Promise<void> {
  const meta = tx.objectStore('meta');
  await meta.put((((await meta.get(GEN_KEY)) as number | undefined) ?? 0) + 1, GEN_KEY);
}

/** Pending rows a push may carry, oldest first: never a rejected or local-only row. */
function uploadable(rows: VersionRow[]): BabyEvent[] {
  return rows
    .filter((r) => r.rejected !== 1 && r.localOnly !== 1)
    .map((r) => r.event)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
}

function toRow(event: BabyEvent, seq: number | null): VersionRow {
  return { key: rowKey(event, seq), id: event.id, babyId: event.babyId, seq, pending: 0, event };
}

function toStored(row: VersionRow): StoredVersion {
  return { seq: row.seq, event: row.event };
}
