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
import { HttpError, httpTransport } from '../data/protocol.ts';
import { EventStore, type Change } from '../data/store.ts';
import { failureReason, SyncClient, type SyncStatus } from '../data/sync.ts';
import {
  coveredThrough,
  syncedSpans,
  waitingOn,
  waitingOnWindow,
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
import { LateTracker, type LateEntry } from './late.ts';
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

/** How long sign-out waits for its write barrier before offering "Sign out anyway". */
const FLUSH_MS = 15_000;
/** Held by the tab that is signing out; a sign-out flag with nobody holding it is stale. */
const SIGN_OUT_LOCK = 'bht-sign-out';
/** Tells the other tabs about a sign-out. The meta flag, not this, is what stops their writes. */
const ACCOUNT_CHANNEL = 'bht-account';
type AccountMessage = 'signing-out' | 'cancelled' | 'signed-out';

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
  /**
   * Whether this session's sync client has adopted a pull that reached through. Until it has,
   * `devices` is the cached list and signed-in checks are not assessed.
   */
  devicesCurrent = $state(false);
  /**
   * Why sign-out could not confirm this phone's logs reached the server. While set, local
   * writes stay stopped and Settings offers "Sign out anyway" or Cancel (step 3b).
   */
  signOutBlocked = $state<string | null>(null);
  /** Another tab is signing out; local writes are refused until it finishes or cancels. */
  signingOutElsewhere = $state(false);
  /** Entries from other phones that arrived after their windows were assessed (step 3b). */
  late = $state.raw<readonly LateEntry[]>([]);

  #store: EventStore | null = null;
  #kv: Storage | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #loading: Promise<void> | null = null;
  #reloadAgain = false;
  #account: Account | null = null;
  #sync: SyncClient | null = null;
  #stopSync: (() => Promise<void>) | null = null;
  #late: LateTracker | null = null;
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
  /** Releases SIGN_OUT_LOCK; set while this tab has stopped local writes for sign-out. */
  #releaseSignOut: (() => void) | null = null;
  #channel: BroadcastChannel | null = null;

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
      this.#listen();
      await this.#staleSignOut();
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
   * A sign-out, in this tab or another, aborts the ceremony and queues behind it. Aborted
   * before verify, it returns
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
   * While syncing, it quiesces first (step 3b): local writes stop in every tab, then a write
   * barrier covers everything this phone wrote, and logout carries that generation so the
   * household stops waiting for this phone. If the barrier cannot finish (offline, or an entry
   * is unanswered or refused), it resolves with `signOutBlocked` set and writes still stopped;
   * the parent then signs out `anyway` or cancels. Signed out anyway, the household keeps
   * waiting for this phone, and when offline the sign-out is on this phone only.
   *
   * A sign-in in flight is aborted, and logout waits for it to settle: a verify already sent
   * may set a session cookie, and logout after it revokes that session as well.
   */
  signOut(opts: { anyway?: boolean } = {}): Promise<void> {
    for (const ceremony of this.#ceremonies) ceremony.abort();
    return this.#serial('signOut', async () => {
      const gen = opts.anyway ? undefined : await this.#quiesce();
      if (gen === null) return;
      this.signOutBlocked = null;
      this.#transition();
      const household = this.account?.householdId;
      await this.#dropSync();
      try {
        await this.#api.logout(gen);
      } catch (e) {
        // An expired session is signed out already. Offline, "anyway" signs out here only.
        const expired = e instanceof AccountError && e.status === 401;
        if (!expired && !(opts.anyway && !(e instanceof HttpError))) {
          this.#resumeAccount();
          if (!this.#releaseSignOut) throw e;
          this.signOutBlocked = `Could not sign out: ${failureReason(e)}.`;
          return;
        }
      }
      if (household) await this.store.resetCursor(household);
      this.#knownBabies = new Set();
      saveJoining(this.#storage, null);
      this.joining = null;
      this.#setAccount(null);
      this.syncStatus = 'idle';
      this.syncError = null;
      await this.#endSignOut();
      this.#broadcast('signed-out');
    });
  }

  /** Gives up a blocked sign-out: writes resume in every tab and sync carries on. */
  cancelSignOut(): Promise<void> {
    return this.#serial('signOut', async () => {
      this.signOutBlocked = null;
      if (!this.#releaseSignOut) return;
      await this.#endSignOut();
      this.#broadcast('cancelled');
      void this.#sync?.sync();
    });
  }

  /**
   * Stops local writes and runs the barrier. Resolves to the write generation it covered,
   * undefined when there is nothing to cover (no sync running, or the session is over), or
   * null when it could not finish and the sign-out is blocked.
   */
  async #quiesce(): Promise<number | undefined | null> {
    const sync = this.#sync;
    if (!sync || this.syncStatus === 'signed_out') return undefined;
    await this.#lockSignOut();
    await this.store.beginSignOut();
    this.#broadcast('signing-out');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gen = await Promise.race([
      sync.flush(),
      new Promise<null>((r) => (timer = setTimeout(() => r(null), FLUSH_MS))),
    ]).finally(() => clearTimeout(timer));
    if (gen !== null) return gen;
    if (sync.status === 'signed_out') return undefined;
    const refused = await this.store.rejectedCount();
    this.signOutBlocked =
      refused > 0
        ? `The server refused ${refused === 1 ? 'an entry' : `${refused} entries`} from this phone.`
        : `This phone could not confirm its logs reached the server: ${sync.error ?? 'no answer'}.`;
    return null;
  }

  /** Takes SIGN_OUT_LOCK for this tab, or throws if another tab is signing out. */
  async #lockSignOut(): Promise<void> {
    if (this.#releaseSignOut) return;
    const locks = globalThis.navigator?.locks;
    if (!locks) {
      this.#releaseSignOut = () => {};
      return;
    }
    const held = await new Promise<boolean>((resolve) => {
      void locks.request(SIGN_OUT_LOCK, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        if (lock) return new Promise<void>((release) => (this.#releaseSignOut = release));
      });
    });
    if (!held) throw new Error('Signing out in another tab');
  }

  /** Clears this tab's sign-out flag and lock, if it holds them. */
  async #endSignOut() {
    const release = this.#releaseSignOut;
    if (!release) return;
    await this.store.endSignOut();
    this.#releaseSignOut = null;
    release();
  }

  /**
   * At startup: a sign-out flag nobody holds the lock for was left by a tab that closed mid
   * sign-out, and would stop writes for good, so it is cleared. Held, another tab is signing out.
   */
  async #staleSignOut() {
    if (!(await this.store.signingOut())) return;
    const locks = globalThis.navigator?.locks;
    if (!locks) {
      await this.store.endSignOut();
      return;
    }
    await locks.request(SIGN_OUT_LOCK, { ifAvailable: true }, async (lock) => {
      if (lock) await this.store.endSignOut();
      else this.signingOutElsewhere = true;
    });
  }

  #listen() {
    if (typeof BroadcastChannel === 'undefined') return;
    this.#channel = new BroadcastChannel(ACCOUNT_CHANNEL);
    this.#channel.onmessage = (e: MessageEvent<AccountMessage>) => {
      this.signingOutElsewhere = e.data === 'signing-out';
      if (e.data !== 'signed-out') return;
      // The other tab cleared the stored account before saying so. A sign-in here that is still
      // running, or that stored its account since, may hold a session set after that logout:
      // sign out here too, which revokes it and clears storage again.
      if (this.#ceremonies.size > 0 || loadAccount(this.#storage)) {
        void this.signOut({ anyway: true }).catch(() => {});
      } else void this.#signedOutElsewhere();
    };
  }

  #broadcast(message: AccountMessage) {
    this.#channel?.postMessage(message);
  }

  /** Another tab signed out: it cleared the stored account and reset the cursor already. */
  #signedOutElsewhere(): Promise<void> {
    return this.#serial('signOut', async () => {
      if (!this.account) return;
      this.#transition();
      await this.#dropSync();
      this.#knownBabies = new Set();
      this.joining = null;
      this.account = null;
      this.syncStatus = 'idle';
      this.syncError = null;
    });
  }

  /**
   * Removes another phone of the household (step 3b): its sessions end and checks from now on
   * stop waiting for it. A pull follows, so the device list shows the removal.
   */
  async removeDevice(deviceId: string): Promise<void> {
    await this.#api.removeDevice(deviceId);
    void this.#sync?.sync();
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
    this.devicesCurrent = false;
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
      current: this.devicesCurrent,
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

  /** The phones a not_synced check's window [start, end] waits on. */
  waitingOnWindow(start: number, end: number, wall: number, mono: number): HouseholdDevice[] {
    const view = this.syncView(wall, mono);
    return view ? waitingOnWindow(view, start, end) : [];
  }

  /** Starts syncing the signed-in household, or resumes after a retried placement. */
  #startSync() {
    if (this.#sync) {
      void this.#sync.resume();
      return;
    }
    const household = this.account?.householdId ?? '';
    let adopted = false;
    let adoptions = 0;
    const sync = new SyncClient(this.store, httpTransport(), {
      household,
      // The watermarks cover what the store holds once the pull reached through, not what this
      // tab last read: another tab may have pulled the rows and moved the shared cursor past
      // them, leaving this pull empty. So the log is re-read first, and the events and the
      // watermarks they are assessed against are published together.
      onAdopt: async (devices, sample) => {
        if (this.#sync !== sync) return;
        const current = this.#fence();
        const n = ++adoptions;
        adopted = true;
        await this.#reload();
        if (!current() || this.#sync !== sync || n !== adoptions) return;
        this.devices = devices;
        this.clockSample = sample;
        this.devicesCurrent = true;
        const wall = Date.now();
        this.#lateTracker()?.record(this.syncedSpans(wall, performance.now()), wall);
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

  /** The signed-in household's late-arrival tracker; null while logs stay on this phone. */
  #lateTracker(): LateTracker | null {
    const household = this.account?.householdId;
    if (!household) return null;
    if (this.#late?.household !== household) this.#late = new LateTracker(this.#storage, household);
    return this.#late;
  }

  /**
   * Marks the entries in a fresh read that arrived from another phone dated where Readings had
   * already counted, against the spans Readings used until now (step 3b). Runs before the read
   * replaces `events`, so the "Count without" marks in that view are the ones counted so far.
   */
  #observeLate(events: BabyEvent[]) {
    const tracker = this.#lateTracker();
    if (!tracker || !this.baby) {
      this.late = [];
      return;
    }
    const wall = Date.now();
    const spans = this.syncedSpans(wall, performance.now());
    tracker.observe(this.baby.id, events, spans, wall, this.store.authorId);
    this.late = tracker.late;
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
        const events = this.baby ? await this.store.events(this.baby.id) : [];
        this.#observeLate(events);
        this.events = events;
        this.rejected = await this.store.rejectedCount();
      } while (this.#reloadAgain);
    })().finally(() => (this.#loading = null));
    return this.#loading;
  }
}

export const app = new AppState();
