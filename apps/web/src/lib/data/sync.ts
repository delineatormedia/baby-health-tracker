import {
  isHouseholdDevice,
  SCHEMA_VERSION,
  type BabyEvent,
  type HouseholdDevice,
} from '@bht/schema';
import type { EventStore } from './store.ts';
import {
  HttpError,
  MAX_PUSH_BATCH,
  MAX_PUSH_BYTES,
  type PushResponse,
  type PushResult,
  type SyncTransport,
} from './protocol.ts';
import { SeededRefusal } from './seeded.ts';
import type { ClockSample } from './watermarks.ts';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'signed_out';

export interface SyncOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  pullLimit?: number;
  /** Target size of one push body in UTF-8 bytes; a batch stops before it passes this. */
  pushByteBudget?: number;
  /** The server's body cap. A version that cannot fit under it alone is refused locally. */
  maxPushBytes?: number;
  random?: () => number;
  onRejected?: (results: PushResult[]) => void;
  /**
   * Runs before each push with the batch about to go up, e.g. to add a baby the server does
   * not have yet. A throw fails the run like a failed push: nothing is sent, and it retries.
   */
  prepare?: (batch: BabyEvent[]) => Promise<void>;
  /** The household this client syncs; its pull cursor is kept under this id. */
  household?: string;
  /**
   * Called once a pull reaches through, with the device list from its first page and that
   * page's clock sample (step 3b). Not called for a pull that was interrupted.
   */
  onAdopt?: (devices: HouseholdDevice[], sample: ClockSample) => void;
  /** Wall and monotonic clocks, for the clock sample; tests replace them. */
  clock?: { wall: () => number; mono: () => number };
}

/** Thrown inside a run that stop() has fenced off; the run ends without touching anything. */
const FENCED = Symbol('fenced');

/**
 * Pushes pending versions, then pulls everything after the cursor. Failures retry with
 * exponential backoff and jitter. A 401 pauses every trigger until resume() after sign-in.
 * Runs are single-flight: a request during a run schedules exactly one more run. Once
 * stopped, a run in flight is fenced: it sends no further request, writes nothing more to the
 * store, and reports no status.
 */
export class SyncClient {
  #status: SyncStatus = 'idle';
  #error: string | null = null;
  #stopped = false;
  /** Bumped by stop(). A run checks it after every await and ends if it moved. */
  #epoch = 0;
  /** The store write a run has in progress, which stop() waits for. */
  #writing: Promise<unknown> | null = null;
  #failures = 0;
  #running: Promise<void> | null = null;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #listeners = new Set<(s: SyncStatus) => void>();
  /** The latest serverNow received: a barrier's `at` must come from before its snapshot. */
  #serverNow: number | null = null;
  /** The write generation the last barrier covered, for flush(). */
  #covered: number | null = null;
  readonly #opts: Required<Omit<SyncOptions, 'onRejected' | 'prepare' | 'onAdopt'>> &
    Pick<SyncOptions, 'onRejected' | 'prepare' | 'onAdopt'>;

  constructor(
    readonly store: EventStore,
    readonly transport: SyncTransport,
    opts: SyncOptions = {},
  ) {
    this.#opts = {
      baseDelayMs: 1_000,
      maxDelayMs: 5 * 60_000,
      pullLimit: 500,
      pushByteBudget: PUSH_BYTE_BUDGET,
      maxPushBytes: MAX_PUSH_BYTES,
      random: Math.random,
      household: '',
      clock: { wall: () => Date.now(), mono: () => performance.now() },
      ...opts,
    };
  }

  get status(): SyncStatus {
    return this.#status;
  }

  /**
   * Why the last run failed, in words Settings can show while the client backs off; null
   * unless status is 'offline'. Status listeners also fire when this changes.
   */
  get error(): string | null {
    return this.#error;
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

  /**
   * One full run that starts after every run in flight, for sign-out (step 3b). Resolves to the
   * write generation its barrier covered, or null if it sent none: the run failed, the session
   * ended, or a version is still unanswered or refused.
   */
  async flush(): Promise<number | null> {
    while (this.#running) await this.#running;
    this.#covered = null;
    await this.sync();
    return this.#status === 'idle' ? this.#covered : null;
  }

  /** Wires browser triggers: local writes, coming back online, and returning to the app. */
  start(): () => Promise<void> {
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
      return this.stop();
    };
  }

  /**
   * Stops syncing: cancels a scheduled retry and fences the run in flight. Resolves once any
   * store write that run had started has finished, so a caller can reset the cursor or switch
   * accounts with nothing landing afterwards. It does not wait on the network: a response
   * still on its way is dropped when it arrives.
   */
  stop(): Promise<void> {
    this.#stopped = true;
    this.#again = false;
    this.#epoch += 1;
    this.#clearTimer();
    return (this.#writing ?? Promise.resolve()).then(
      () => {},
      () => {},
    );
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
    const epoch = this.#epoch;
    this.#setStatus('syncing');
    try {
      await this.#push(epoch);
      await this.#pull(epoch);
      await this.#barrier(epoch);
      this.#fence(epoch);
      this.#failures = 0;
      this.#setStatus('idle');
    } catch (err) {
      if (err === FENCED || epoch !== this.#epoch) return;
      if (err instanceof HttpError && err.status === 401) {
        this.#setStatus('signed_out');
        return;
      }
      this.#failures += 1;
      this.#setStatus('offline', failureReason(err));
      if (this.#stopped) return;
      this.#timer = setTimeout(() => void this.sync(), this.backoffMs(this.#failures));
    }
  }

  /**
   * Pushes pending versions in batches of at most MAX_PUSH_BATCH versions and pushByteBudget
   * bytes. A 413 halves the batch for the rest of this run. A version too large to send on its
   * own (over maxPushBytes, or over pushByteBudget and answered 413) is refused on this phone
   * (`too_large`), kept and counted like a server refusal, so the rest of the backlog drains.
   */
  async #push(epoch: number) {
    let cap = MAX_PUSH_BATCH;
    for (;;) {
      const pending = await this.store.pending(MAX_PUSH_BATCH);
      this.#fence(epoch);
      if (pending.length === 0) return;
      const batch = takeBatch(pending, cap, this.#opts.pushByteBudget);
      if (pushBytes(batch.slice(0, 1)) > this.#opts.maxPushBytes) {
        await this.#refuseLocally(batch[0]!);
        continue;
      }
      await this.#opts.prepare?.(batch);
      this.#fence(epoch);
      let response: PushResponse;
      try {
        response = await this.transport.push(batch);
      } catch (err) {
        this.#fence(epoch);
        if (!(err instanceof HttpError && err.status === 413)) throw err;
        if (batch.length > 1) cap = Math.ceil(batch.length / 2);
        else if (pushBytes(batch) > this.#opts.pushByteBudget) await this.#refuseLocally(batch[0]!);
        // A small version refused as too large means a proxy or server cap below ours. Keep it
        // pending and back off rather than refuse versions any correctly configured server takes.
        else throw err;
        continue;
      }
      const { results } = response;
      this.#fence(epoch);
      this.#heard(response.serverNow);
      const rejected = await this.#write(this.store.applyPushResults(batch, results));
      this.#fence(epoch);
      if (rejected.length > 0) this.#opts.onRejected?.(rejected);
      if (batch.length === pending.length && pending.length < MAX_PUSH_BATCH) return;
    }
  }

  async #refuseLocally(event: BabyEvent) {
    const { id, version } = event;
    const refusal: PushResult = { id, version, status: 'rejected', error: TOO_LARGE };
    const rejected = await this.#write(this.store.applyPushResults([event], [refusal]));
    if (rejected.length > 0) this.#opts.onRejected?.(rejected);
  }

  /**
   * Pages until the server's `through` from the first page. Versions pushed while this pull
   * runs land past it and wait for the next pull, so one pull reads one snapshot's worth.
   *
   * The clock sample is read just before the first page is sent: the server reads serverNow
   * after that, so serverNow − tSend bounds the clock offset from above however slow either
   * leg is (step 3b). tRecv, read when the page arrives, bounds it from below. The whole pull keeps the first page's sample and device list, and both
   * are adopted with the page that reaches through.
   */
  async #pull(epoch: number) {
    const { household, pullLimit, clock } = this.#opts;
    let through: number | undefined;
    let first: { devices?: HouseholdDevice[]; sample?: ClockSample } | undefined;
    for (;;) {
      const after = await this.store.cursor(household);
      this.#fence(epoch);
      const sent = first ? null : { tSend: clock.wall(), pSend: clock.mono() };
      const page = await this.transport.pull(after, pullLimit, through);
      this.#fence(epoch);
      if (page.devices !== undefined && !page.devices.every(isHouseholdDevice)) {
        throw new MalformedDevices();
      }
      this.#heard(page.serverNow);
      through ??= page.through;
      first ??= {
        devices: page.devices,
        sample:
          sent && page.serverNow !== undefined
            ? { ...sent, serverNow: page.serverNow, tRecv: clock.wall() }
            : undefined,
      };
      await this.#write(this.store.applyPull(page, household, first.devices));
      if (page.more) continue;
      this.#fence(epoch);
      if (first.devices && first.sample) this.#opts.onAdopt?.(first.devices, first.sample);
      return;
    }
  }

  /**
   * The acknowledged write barrier (step 3b). Reads the write generation with the pending rows,
   * pushes them, and once the server has answered for every one, tells it everything up to
   * that generation is there, as of a serverNow received before the snapshot. Sends nothing
   * while any version is unanswered or an entry stays refused: other phones cannot see it.
   */
  async #barrier(epoch: number) {
    const at = this.#serverNow;
    if (at === null) return;
    const snapshot = await this.store.snapshot();
    this.#fence(epoch);
    if (snapshot.pending.length > 0) await this.#push(epoch);
    const acked = await this.store.acknowledged(snapshot.pending);
    this.#fence(epoch);
    if (!acked) return;
    const refused = await this.store.rejectedCount();
    this.#fence(epoch);
    if (refused > 0) return;
    const { serverNow } = await this.transport.barrier({
      deviceId: this.store.authorId,
      gen: snapshot.gen,
      at,
    });
    this.#fence(epoch);
    this.#heard(serverNow);
    this.#covered = snapshot.gen;
  }

  #heard(serverNow: number | undefined) {
    if (serverNow !== undefined) this.#serverNow = serverNow;
  }

  /** Records a store write in progress for stop() to wait on. Call only right after #fence. */
  async #write<T>(write: Promise<T>): Promise<T> {
    this.#writing = write;
    try {
      return await write;
    } finally {
      if (this.#writing === write) this.#writing = null;
    }
  }

  /** Ends a run that stop() fenced off, before its next request or store write. */
  #fence(epoch: number) {
    if (epoch !== this.#epoch) throw FENCED;
  }

  #setStatus(s: SyncStatus, error: string | null = null) {
    if (s === this.#status && error === this.#error) return;
    this.#status = s;
    this.#error = error;
    for (const l of this.#listeners) l(s);
  }

  #clearTimer() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/** A failed run's reason as Settings shows it. */
export function failureReason(err: unknown): string {
  if (err instanceof SeededRefusal || err instanceof MalformedDevices) return err.message;
  if (!(err instanceof HttpError)) return 'No connection to the server';
  if (err.status === 413) return 'Server rejected upload size';
  if (err.status === 409) return 'Server needs an update before this app can sync';
  return `Server error (HTTP ${err.status})`;
}

/** Error recorded on a version refused on this phone because no push can carry it. */
export const TOO_LARGE = 'too_large';

/** Default push body target: well under the server's MAX_PUSH_BYTES. */
export const PUSH_BYTE_BUDGET = 1.5 * 1024 * 1024;

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const ENVELOPE_BYTES = bytes({ schemaVersion: SCHEMA_VERSION, events: [] });

/** UTF-8 size of the push body httpTransport sends for `events`. */
export function pushBytes(events: BabyEvent[]): number {
  return ENVELOPE_BYTES + events.reduce((n, e, i) => n + bytes(e) + (i > 0 ? 1 : 0), 0);
}

/**
 * The longest prefix of `pending` with at most `cap` versions whose push body fits `budget`
 * bytes. Always at least one version, so one over the budget still goes up on its own.
 */
export function takeBatch(pending: BabyEvent[], cap: number, budget: number): BabyEvent[] {
  let size = ENVELOPE_BYTES;
  let n = 0;
  for (const e of pending.slice(0, cap)) {
    size += bytes(e) + (n > 0 ? 1 : 0);
    if (n > 0 && size > budget) break;
    n += 1;
  }
  return pending.slice(0, n);
}

/**
 * A pull page whose device list has a row without the wire shape. The page is rejected before
 * anything from it is written or adopted, so Readings keeps waiting (step 3b).
 */
export class MalformedDevices extends Error {
  constructor() {
    super('Server sent an unreadable device list');
  }
}
