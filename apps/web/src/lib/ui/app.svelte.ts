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
  loadBaby,
  loadPrefs,
  memoryStorage,
  saveBaby,
  savePrefs,
  type Prefs,
} from './prefs.ts';
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
  prefs = $state<Prefs>(loadPrefs(globalThis.localStorage ?? memoryStorage()));
  toast = $state.raw<Toast | null>(null);
  /** Wall clock for elapsed-time displays, ticking once a second. */
  now = $state(Date.now());

  #store: EventStore | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #loading: Promise<void> | null = null;
  #reloadAgain = false;

  async init(): Promise<void> {
    if (this.#store) return;
    try {
      this.#store = new EventStore(await openDatabase(), authorId(localStorage));
      this.baby = loadBaby(localStorage);
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

  setBaby(baby: Baby): void {
    saveBaby(localStorage, baby);
    this.baby = baby;
    void this.#reload();
  }

  setPrefs(patch: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    savePrefs(localStorage, this.prefs);
  }

  volume = (ml: number): string => formatVolume(ml, this.prefs.volume);

  async log<T extends EventType>(
    type: T,
    data: EventData<T>,
    label: string,
    opts: { occurredAt?: string } = {},
  ): Promise<Change> {
    const baby = this.baby;
    if (!baby) throw new Error('No baby');
    const change = await this.store.log(baby.id, type, data, opts);
    this.showUndo(`${label} logged · ${time(change.event.occurredAt)}`, change);
    return change;
  }

  showUndo(text: string, change: Change): void {
    this.#showToast({
      text,
      undo: async () => {
        await change.undo();
        this.#showToast({ text: 'Undone' });
      },
    });
  }

  dismissToast(): void {
    clearTimeout(this.#toastTimer);
    this.toast = null;
  }

  #showToast(t: Toast) {
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
