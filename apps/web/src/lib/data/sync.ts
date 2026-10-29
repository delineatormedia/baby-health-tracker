import type { EventStore } from './store.ts';
import { HttpError, MAX_PUSH_BATCH, type PushResult, type SyncTransport } from './protocol.ts';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'signed_out';

export interface SyncOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  pullLimit?: number;
  random?: () => number;
  onRejected?: (results: PushResult[]) => void;
}

/**
 * Pushes pending versions, then pulls everything after the cursor. Failures retry with
 * exponential backoff and jitter. A 401 pauses every trigger until resume() after sign-in.
 * Runs are single-flight: a request during a run schedules exactly one more run. Once
 * stopped, nothing in flight schedules more work.
 */
export class SyncClient {
  #status: SyncStatus = 'idle';
  #stopped = false;
  #failures = 0;
  #running: Promise<void> | null = null;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #listeners = new Set<(s: SyncStatus) => void>();
  readonly #opts: Required<Omit<SyncOptions, 'onRejected'>> & Pick<SyncOptions, 'onRejected'>;

  constructor(
    readonly store: EventStore,
    readonly transport: SyncTransport,
    opts: SyncOptions = {},
  ) {
    this.#opts = {
      baseDelayMs: 1_000,
      maxDelayMs: 5 * 60_000,
      pullLimit: 500,
      random: Math.random,
      ...opts,
    };
  }

  get status(): SyncStatus {
    return this.#status;
  }

  /** Delay before retry number `failures` (1-based): base·2^(n-1), capped, scaled by 0.5–1. */
  backoffMs(failures: number): number {
    const { baseDelayMs, maxDelayMs, random } = this.#opts;
    const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** (failures - 1));
    return Math.round(capped * (0.5 + random() / 2));
  }

  /** Syncs now, or once more after the run in flight. Resolves when that sync settles. */
  sync(): Promise<void> {
    if (this.#stopped || this.#status === 'signed_out') return this.#running ?? Promise.resolve();
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#clearTimer();
    this.#running = this.#run().finally(() => {
      this.#running = null;
      const again = this.#again;
      this.#again = false;
      if (again) void this.sync();
    });
    return this.#running;
  }

  /** Wires browser triggers: local writes, coming back online, and returning to the app. */
  start(): () => void {
    this.#stopped = false;
    const onChange = () => void this.sync();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.sync();
    };
    const unsubscribe = this.store.subscribeLocal(onChange);
    window.addEventListener('online', onChange);
    document.addEventListener('visibilitychange', onVisible);
    void this.sync();
    return () => {
      unsubscribe();
      window.removeEventListener('online', onChange);
      document.removeEventListener('visibilitychange', onVisible);
      this.stop();
    };
  }

  /** Stops syncing: cancels a scheduled retry, and a run in flight schedules nothing more. */
  stop(): void {
    this.#stopped = true;
    this.#again = false;
    this.#clearTimer();
  }

  /** Call after a successful sign-in: lifts the 401 pause and syncs. */
  resume(): Promise<void> {
    if (this.#status === 'signed_out') this.#setStatus('idle');
    this.#failures = 0;
    return this.sync();
  }

  onStatus(listener: (s: SyncStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #run(): Promise<void> {
    this.#setStatus('syncing');
    try {
      await this.#push();
      await this.#pull();
      this.#failures = 0;
      this.#setStatus('idle');
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        this.#setStatus('signed_out');
        return;
      }
      this.#failures += 1;
      this.#setStatus('offline');
      if (this.#stopped) return;
      this.#timer = setTimeout(() => void this.sync(), this.backoffMs(this.#failures));
    }
  }

  async #push() {
    for (;;) {
      const batch = await this.store.pending(MAX_PUSH_BATCH);
      if (batch.length === 0) return;
      const { results } = await this.transport.push(batch);
      const rejected = await this.store.applyPushResults(batch, results);
      if (rejected.length > 0) this.#opts.onRejected?.(rejected);
      if (batch.length < MAX_PUSH_BATCH) return;
    }
  }

  async #pull() {
    for (;;) {
      const page = await this.transport.pull(await this.store.cursor(), this.#opts.pullLimit);
      await this.store.applyPull(page);
      if (!page.more) return;
    }
  }

  #setStatus(s: SyncStatus) {
    if (s === this.#status) return;
    this.#status = s;
    for (const l of this.#listeners) l(s);
  }

  #clearTimer() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
