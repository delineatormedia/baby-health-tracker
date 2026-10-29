import {
  formatVolume,
  type Baby,
  type BabyEvent,
  type EventData,
  type EventType,
} from '@bht/schema';
import { openDatabase } from '../data/db.ts';
import { EventStore, type Change } from '../data/store.ts';
import {
  authorId,
  DEFAULT_PREFS,
  loadBaby,
  loadPrefs,
  saveBaby,
  savePrefs,
  type Prefs,
} from './prefs.ts';
import { saveFailure } from './logic.ts';
import { time } from './time.ts';

export { time };

export interface Toast {
  text: string;
  /** Absent once undone, or for a plain notice. */
  undo?: () => Promise<unknown>;
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
  events = $state.raw<BabyEvent[]>([]);
  // Read in init(): touching localStorage can throw (SecurityError) and must reach the error screen.
  prefs = $state<Prefs>(DEFAULT_PREFS);
  toast = $state.raw<Toast | null>(null);
  /** A write that failed. Shown until dismissed or the next write succeeds. */
  saveError = $state<string | null>(null);
  /** Wall clock for elapsed-time displays, ticking once a second. */
  now = $state(Date.now());

  #store: EventStore | null = null;
  #kv: Storage | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #loading: Promise<void> | null = null;
  #reloadAgain = false;

  async init(): Promise<void> {
    if (this.#store) return;
    try {
      // Prefs load before the first await so the theme applies on first paint.
      const kv = globalThis.localStorage;
      if (!kv) throw new Error('Local storage is unavailable.');
      this.prefs = loadPrefs(kv);
      this.#kv = kv;
      this.#store = new EventStore(await openDatabase(), authorId(kv));
      this.baby = loadBaby(kv);
      this.#store.subscribe(() => void this.#reload());
      await this.#reload();
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

  setBaby(baby: Baby): void {
    try {
      saveBaby(this.#storage, baby);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.baby = baby;
    void this.#reload();
  }

  /** Applies for this session even if the phone cannot store it. */
  setPrefs(patch: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    try {
      savePrefs(this.#storage, this.prefs);
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Reports a failed write. Screens call this from their catch and stay where they are, so
   * whatever the parent entered is still there to retry. The stale success toast goes away.
   */
  fail(e: unknown): void {
    console.error(e);
    this.dismissToast();
    this.saveError = saveFailure(e);
  }

  volume = (ml: number): string => formatVolume(ml, this.prefs.volume);

  async log<T extends EventType>(
    type: T,
    data: EventData<T>,
    /** Toast text, e.g. "Wet logged"; the time is appended. */
    label: string,
    opts: { occurredAt?: string } = {},
  ): Promise<Change> {
    const baby = this.baby;
    if (!baby) throw new Error('No baby');
    const change = await this.store.log(baby.id, type, data, opts);
    this.showUndo(`${label} · ${time(change.event.occurredAt)}`, change);
    return change;
  }

  showUndo(text: string, change: Change): void {
    this.#showToast({
      text,
      undo: async () => {
        try {
          await change.undo();
        } catch (e) {
          this.fail(e);
          return;
        }
        this.#showToast({ text: 'Undone' });
      },
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
      } while (this.#reloadAgain);
    })().finally(() => (this.#loading = null));
    return this.#loading;
  }
}

export const app = new AppState();
