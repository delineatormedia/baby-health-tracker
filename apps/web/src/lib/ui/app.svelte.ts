import {
  formatVolume,
  type Baby,
  type BabyEvent,
  type EventData,
  type EventType,
  type HouseholdDevice,
  type SignedIn,
} from '@bht/schema';
import { Account, AccountError, browserPasskeys, httpAccount } from '../data/account.ts';
import { openDatabase } from '../data/db.ts';
import { httpTransport } from '../data/protocol.ts';
import { EventStore, type Change } from '../data/store.ts';
import { failureReason, SyncClient, type SyncStatus } from '../data/sync.ts';
import {
  coveredThrough,
  syncedSpans,
  waitingOn,
  type ClockSample,
  type Spans,
  type SyncView,
} from '../data/watermarks.ts';
import {
  authorId,
  DEFAULT_PREFS,
  loadAccount,
  loadBaby,
  loadJoining,
  loadSetupAt,
  markSetup,
  loadHomeNoteDismissed,
  loadPrefs,
  loadSeeded,
  mintAuthorId,
  saveAccount,
  saveBaby,
  saveHomeNoteDismissed,
  saveJoining,
  savePrefs,
  type Prefs,
  type StoredAccount,
} from './prefs.ts';
import { babyPreparer, placeBaby } from './session.ts';
import { editLink, saveFailure, type EditPath } from './logic.ts';
import { vouches } from './readings.ts';
import { ensurePersisted, isStandalone, showHomeScreenNote, type Persistence } from './storage.ts';
import { time, when } from './time.ts';

export { time };

export interface Toast {
  text: string;
  /** Absent once undone, or for a plain notice. */
  undo?: () => Promise<unknown>;
  /** "Change time" or "Details": reopens the event just logged. */
  edit?: { label: string; path: EditPath };
}

/** A failed write, shown until dismissed or the next write succeeds. */
export interface SaveError {
  text: string;
  /** Repeats the failed operation, e.g. an Undo that did not save. */
  retry?: { label: string; run: () => Promise<unknown> };
}

const TOAST_MS = 6_000;

/**
 * App state shared by every screen. Writes go to IndexedDB through EventStore and are visible
 * as soon as the local transaction commits; nothing here waits on the network.
 */
class AppState {
  ready = $state(false);
  error = $state<string | null>(null);
  baby = $state<Baby | null>(null);
  /** When this phone set up its baby (ms); null on installs from before it was recorded. */
  setupAt = $state<number | null>(null);
  events = $state.raw<BabyEvent[]>([]);
  /** Entries the server refused (#5). They stay on this phone; Settings shows the count. */
  rejected = $state(0);
  // Read in init(): touching localStorage can throw (SecurityError) and must reach the error screen.
  prefs = $state<Prefs>(DEFAULT_PREFS);
  toast = $state.raw<Toast | null>(null);
  saveError = $state.raw<SaveError | null>(null);
  /** Opened from the Home Screen, where Safari's 7-day storage cap doesn't apply (#42). */
  standalone = $state(false);
  /** Whether the browser has promised to keep this phone's logs; Settings shows it. */
  persistence = $state<Persistence>('unknown');
  homeNoteDismissed = $state(false);
  /** Dev test data was loaded here (#58): badged, and never synced to a real server. */
  seeded = $state(false);
  /** Wall clock for elapsed-time displays, ticking once a second. */
  now = $state(Date.now());
  /** The household this phone signed in to (#5 step 3); null while logs stay on this phone. */
  account = $state.raw<StoredAccount | null>(null);
  /**
   * The household baby this phone signed in next to its own: its entries are moved or kept
   * off before sync starts. Null otherwise.
   */
  joining = $state.raw<Baby | null>(null);
  syncStatus = $state<SyncStatus>('idle');
  /** SyncClient.error, or why the household could not be loaded after sign-in. */
  syncError = $state<string | null>(null);
  /** The account transition running now; Settings holds back the other one meanwhile. */
  transition = $state<'signIn' | 'signOut' | null>(null);
  /**
   * The household's phones from the last complete pull, kept across reloads for the "last
   * synced" text (step 3b). Null until one is adopted for the signed-in household.
   */
  devices = $state.raw<HouseholdDevice[] | null>(null);
  /** That pull's clock sample. In memory only: after a reload, windows wait for a pull. */
  clockSample = $state.raw<ClockSample | null>(null);

  #store: EventStore | null = null;
  #kv: Storage | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #loading: Promise<void> | null = null;
  #reloadAgain = false;
  #account: Account | null = null;
  #sync: SyncClient | null = null;
  #stopSync: (() => Promise<void>) | null = null;
  /**
   * Baby ids the server has, from the last household load. Replaced, not cleared, so a
   * stopped client's late prepare cannot add to the set the next client reads.
   */
  #knownBabies = new Set<string>();
  /**
   * Bumped by every account transition (sign-in, sign-out). Async account work captures it
   * with #fence() and, after each await, drops itself if it moved: no state written, no sync
   * started, no error shown. A late answer for the old account cannot bring it back.
   */
  #epoch = 0;
  /** Sign-ins and sign-outs, one at a time: each starts once the one before has settled. */
  #transitions: Promise<unknown> = Promise.resolve();
  /** Sign-ins queued or running; a sign-out aborts their ceremonies. */
  #ceremonies = new Set<AbortController>();

  async init(): Promise<void> {
    if (this.#store) return;
    try {
      // Prefs load before the first await so the theme applies on first paint.
      const kv = globalThis.localStorage;
      if (!kv) throw new Error('Local storage is unavailable.');
      this.prefs = loadPrefs(kv);
      this.#kv = kv;
      // Dev builds only (#58): `?seed=healthy-month` replaces local data with test data.
      if (import.meta.env.DEV) {
        await (await import('../dev/seed.ts')).seedFromUrl(kv, () => openDatabase());
      }
      this.seeded = loadSeeded(kv);
      this.#store = new EventStore(await openDatabase(), authorId(kv));
      this.baby = loadBaby(kv);
      this.setupAt = loadSetupAt(kv);
      this.standalone = isStandalone({
        matchMedia: globalThis.matchMedia?.bind(globalThis),
        // iOS Safari only; not in the DOM typings.
        navigator: globalThis.navigator as { standalone?: boolean } | undefined,
      });
      this.homeNoteDismissed = loadHomeNoteDismissed(kv);
      if (this.baby) void this.#persist();
      this.account = loadAccount(kv);
      this.joining = loadJoining(kv);
      this.#account = new Account(httpAccount(), browserPasskeys(), {
        get: () => authorId(kv),
        mint: () => (this.store.authorId = mintAuthorId(kv)),
      });
      this.#store.subscribe(() => void this.#reload());
      await this.#reload();
      if (this.account?.placed === false) this.place().catch(() => {});
      else if (this.account && !this.joining) this.#startSync();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.ready = true;
    setInterval(() => (this.now = Date.now()), 1000);
    document.addEventListener('visibilitychange', () => (this.now = Date.now()));
  }

  get store(): EventStore {
    if (!this.#store) throw new Error('App not initialised');
    return this.#store;
  }

  get #storage(): Storage {
    if (!this.#kv) throw new Error('App not initialised');
    return this.#kv;
  }

  get #api(): Account {
    if (!this.#account) throw new Error('App not initialised');
    return this.#account;
  }

  /**
   * Runs a sign-in ceremony (register, join or login), then places this phone's baby. The
   * account is stored before the household loads, marked unplaced, so a failed load retries
   * later instead of leaving a session nobody knows about. Sync waits for placement.
   *
   * The old account's sync client is stopped and drained before the ceremony sets the new
   * session cookie, so none of its requests go out under the new account. Each household
   * keeps its own pull cursor, so signing in to another one pulls it from the start.
   *
   * A sign-out aborts the ceremony and queues behind it. Aborted before verify, it returns
   * with nothing sent. Once verify is out, the server has the session whatever happens here,
   * so the account is stored (the sign-out behind clears it) but not placed.
   */
  async signIn(
    ceremony: (account: Account, signal: AbortSignal) => Promise<SignedIn>,
  ): Promise<void> {
    const abort = new AbortController();
    this.#ceremonies.add(abort);
    const signedIn = await this.#serial('signIn', async () => {
      try {
        if (abort.signal.aborted) return false;
        this.#transition();
        await this.#dropSync();
        let signedIn: SignedIn;
        try {
          signedIn = await ceremony(this.#api, abort.signal);
        } catch (e) {
          if (abort.signal.aborted) return false;
          this.#resumeAccount();
          throw e;
        }
        this.#setAccount({
          householdId: signedIn.householdId,
          memberId: signedIn.memberId,
          placed: false,
        });
        return !abort.signal.aborted;
      } finally {
        this.#ceremonies.delete(abort);
      }
    });
    if (signedIn) await this.place();
  }

  /**
   * Loads the household and decides about this phone's baby (see placeBaby). A phone holding
   * no rows at all for its own baby just takes the household's. Any row counts, an undone
   * entry's tombstone included: otherwise those versions would upload under a household
   * without the baby. Throws, with syncError set, if the household cannot be loaded; Settings
   * offers a retry. Superseded by a sign-in or sign-out, it returns without touching anything.
   */
  async place(): Promise<void> {
    const current = this.#fence();
    const account = this.account;
    if (!account) return;
    let household;
    try {
      household = await this.#api.household();
    } catch (e) {
      if (!current()) return;
      if (e instanceof AccountError && e.status === 401) {
        this.syncStatus = 'signed_out';
        this.syncError = null;
      } else {
        this.syncStatus = 'offline';
        this.syncError = `Could not load your household: ${failureReason(e)}`;
      }
      throw e;
    }
    if (!current()) return;
    const placement = placeBaby(this.baby, household);
    const choose = placement.kind === 'choose' && (await this.store.hasRows(this.baby!.id));
    if (!current()) return;
    this.#knownBabies = new Set(household.babies.map((b) => b.id));
    if (choose) {
      saveJoining(this.#storage, placement.baby);
      this.joining = placement.baby;
    } else if (placement.kind !== 'keep' && placement.kind !== 'none') {
      this.#adopt(placement.baby);
    }
    this.#setAccount({ householdId: account.householdId, memberId: account.memberId });
    if (!this.joining) this.#startSync();
  }

  /**
   * The joining phone's choice about its own baby's entries: move them into the household
   * baby, or keep them on this phone only. One store transaction either way; the choice is
   * recorded only after it commits, so a reload before then asks again.
   */
  async settleJoin(move: boolean): Promise<void> {
    const from = this.baby;
    const to = this.joining;
    if (!from || !to) return;
    const current = this.#fence();
    if (move) await this.store.moveBaby(from.id, to.id);
    else await this.store.archiveBaby(from.id);
    if (!current()) return;
    this.#adopt(to);
    saveJoining(this.#storage, null);
    this.joining = null;
    this.#startSync();
  }

  /**
   * Revokes this phone's session. Logs stay here; the next sign-in pulls from the start. Sync
   * is stopped and drained first, so no late response lands after the cursor is reset.
   *
   * A sign-in in flight is aborted, and logout waits for it to settle: a verify already sent
   * may set a session cookie, and logout after it revokes that session as well.
   */
  signOut(): Promise<void> {
    for (const ceremony of this.#ceremonies) ceremony.abort();
    return this.#serial('signOut', async () => {
      this.#transition();
      const household = this.account?.householdId;
      await this.#dropSync();
      try {
        await this.#api.logout();
      } catch (e) {
        // An expired session is signed out already.
        if (!(e instanceof AccountError && e.status === 401)) {
          this.#resumeAccount();
          throw e;
        }
      }
      if (household) await this.store.resetCursor(household);
      this.#knownBabies = new Set();
      saveJoining(this.#storage, null);
      this.joining = null;
      this.#setAccount(null);
      this.syncStatus = 'idle';
      this.syncError = null;
    });
  }

  /** An invite code for the other parent. */
  invite() {
    return this.#api.invite();
  }

  /** Captures the account epoch; the returned check is false once a transition has begun. */
  #fence(): () => boolean {
    const epoch = this.#epoch;
    return () => epoch === this.#epoch;
  }

  /** Begins an account transition: work fenced under the previous account drops itself. */
  #transition() {
    this.#epoch++;
  }

  /** Runs an account transition after the ones before it have settled, failed or not. */
  #serial<T>(kind: 'signIn' | 'signOut', run: () => Promise<T>): Promise<T> {
    const next = this.#transitions.then(async () => {
      this.transition = kind;
      try {
        return await run();
      } finally {
        this.transition = null;
      }
    });
    this.#transitions = next.catch(() => {});
    return next;
  }

  /**
   * After a failed sign-in or sign-out: the account is unchanged, but the transition dropped
   * its sync and any placement in flight, so put back whichever one it was running.
   */
  #resumeAccount() {
    if (this.account?.placed === false) this.place().catch(() => {});
    else if (this.account && !this.joining) this.#startSync();
  }

  #setAccount(account: StoredAccount | null) {
    saveAccount(this.#storage, account);
    this.account = account;
  }

  #adopt(baby: Baby) {
    saveBaby(this.#storage, baby);
    this.setupAt = markSetup(this.#storage, Date.now());
    this.baby = baby;
    void this.#reload();
  }

  /** Stops the sync client, if any, and waits for a store write its run had started. */
  async #dropSync(): Promise<void> {
    const stop = this.#stopSync;
    this.#stopSync = null;
    this.#sync = null;
    this.devices = null;
    this.clockSample = null;
    await stop?.();
  }

  /**
   * What Readings knows about the other phones, at this wall and monotonic time, with the
   * baby's live "Count without" marks. Null when this phone is not signed in: its log is then
   * the whole log.
   */
  syncView(wall: number, mono: number): SyncView | null {
    if (!this.account) return null;
    return {
      devices: this.devices,
      self: this.store.authorId,
      sample: this.clockSample,
      wall,
      mono,
      vouches: vouches(this.events),
    };
  }

  /** Readings' synced spans (ms): everything when not signed in, else what the phones cover. */
  syncedSpans(wall: number, mono: number): Spans {
    const view = this.syncView(wall, mono);
    return view ? syncedSpans(view) : [[-Infinity, Infinity]];
  }

  /** The phones the window [start, end] waits on. */
  waitingOn(start: number, end: number, wall: number, mono: number): HouseholdDevice[] {
    const view = this.syncView(wall, mono);
    return view ? waitingOn(view, end, start) : [];
  }

  /** W_local(D) now, the start of a "Count without D" mark; null when unknown. */
  coveredThrough(d: HouseholdDevice, wall: number, mono: number): number | null {
    const view = this.syncView(wall, mono);
    return view ? coveredThrough(view, d) : null;
  }

  /** Starts syncing the signed-in household, or resumes after a retried placement. */
  #startSync() {
    if (this.#sync) {
      void this.#sync.resume();
      return;
    }
    const household = this.account?.householdId ?? '';
    let adopted = false;
    const sync = new SyncClient(this.store, httpTransport(), {
      household,
      onAdopt: (devices, sample) => {
        if (this.#sync !== sync) return;
        adopted = true;
        this.devices = devices;
        this.clockSample = sample;
      },
      prepare: babyPreparer(
        (b) => this.#api.addBaby(b),
        this.#knownBabies,
        () => this.baby,
      ),
      onRejected: (refused) =>
        this.#showToast({
          text: `The server refused ${refused.length === 1 ? 'an entry' : `${refused.length} entries`}. See Settings.`,
        }),
    });
    sync.onStatus((s) => {
      this.syncStatus = s;
      this.syncError = sync.error;
    });
    this.#sync = sync;
    this.#stopSync = sync.start();
    // The list kept from an earlier session shows "last synced" until this client's first pull.
    void this.store.devices(household).then((devices) => {
      if (this.#sync === sync && !adopted) this.devices = devices;
    });
  }

  setBaby(baby: Baby): void {
    try {
      saveBaby(this.#storage, baby);
      this.setupAt = markSetup(this.#storage, Date.now());
    } catch (e) {
      this.fail(e);
      return;
    }
    this.baby = baby;
    void this.#reload();
    void this.#persist();
  }

  get showHomeNote(): boolean {
    return showHomeScreenNote({
      hasBaby: this.baby !== null,
      standalone: this.standalone,
      dismissed: this.homeNoteDismissed,
    });
  }

  /** Hides the Add to Home Screen note; for this session only if the phone can't store that. */
  dismissHomeNote(): void {
    this.homeNoteDismissed = true;
    try {
      saveHomeNoteDismissed(this.#storage);
    } catch (e) {
      console.error(e);
    }
  }

  async #persist(): Promise<void> {
    this.persistence = await ensurePersisted(globalThis.navigator?.storage, this.standalone);
  }

  /** Applies for this session even if the phone cannot store it, and says so. */
  setPrefs(patch: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    try {
      savePrefs(this.#storage, this.prefs);
    } catch (e) {
      console.error(e);
      this.dismissToast();
      this.saveError = {
        text: `${saveFailure(e)} The setting applies for this session only.`,
      };
    }
  }

  /**
   * Reports a failed write. Screens call this from their catch and stay where they are, so
   * whatever the parent entered is still there to retry. The stale success toast goes away.
   */
  fail(e: unknown, retry?: SaveError['retry']): void {
    console.error(e);
    this.dismissToast();
    this.saveError = {
      text: `${saveFailure(e)} ${retry ? 'Nothing changed.' : 'Nothing changed. Try again.'}`,
      retry,
    };
  }

  /** Runs a failed write's retry once; a second failure puts it back in the banner. */
  retrySave(): void {
    const retry = this.saveError?.retry;
    this.saveError = null;
    if (retry) void retry.run();
  }

  volume = (ml: number): string => formatVolume(ml, this.prefs.volume);

  async log<T extends EventType>(
    type: T,
    data: EventData<T>,
    /** Toast text, e.g. "Wet logged"; the time is appended. */
    label: string,
    /** `day` replaces the appended time for a mark about a whole day, e.g. "Yesterday". */
    opts: { occurredAt?: string; day?: string } = {},
  ): Promise<Change> {
    const baby = this.baby;
    if (!baby) throw new Error('No baby');
    const change = await this.store.log(baby.id, type, data, { occurredAt: opts.occurredAt });
    this.showUndo(`${label} · ${opts.day ?? when(change.event.occurredAt, Date.now())}`, change);
    return change;
  }

  showUndo(text: string, change: Change): void {
    // A failed Undo keeps its inverse in the error banner until it lands or is dismissed.
    const undo = async () => {
      try {
        await change.undo();
      } catch (e) {
        this.fail(e, { label: 'Retry undo', run: undo });
        return;
      }
      this.#showToast({ text: 'Undone' });
    };
    this.#showToast({
      text,
      edit: change.event.deleted ? undefined : editLink(change.event),
      undo,
    });
  }

  dismissToast(): void {
    clearTimeout(this.#toastTimer);
    this.toast = null;
  }

  #showToast(t: Toast) {
    this.saveError = null;
    clearTimeout(this.#toastTimer);
    this.toast = t;
    this.#toastTimer = setTimeout(() => (this.toast = null), TOAST_MS);
  }

  /** Re-reads the log after any change. Overlapping calls coalesce into one more read. */
  #reload(): Promise<void> {
    if (this.#loading) {
      this.#reloadAgain = true;
      return this.#loading;
    }
    this.#loading = (async () => {
      do {
        this.#reloadAgain = false;
        this.events = this.baby ? await this.store.events(this.baby.id) : [];
        this.rejected = await this.store.rejectedCount();
      } while (this.#reloadAgain);
    })().finally(() => (this.#loading = null));
    return this.#loading;
  }
}

export const app = new AppState();
