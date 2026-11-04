import {
  clearedIn,
  SCHEMA_VERSION,
  type BabyEvent,
  type BarrierRequest,
  type BarrierResponse,
  type ClearId,
  type ClearMarker,
  type PullResponse,
  type PushRequest,
  type PushResponse,
} from '@bht/schema';
import { refuseSeeded } from './seeded.ts';

// The /api/sync wire format lives in @bht/schema (protocol.ts), shared with the server.
export {
  MAX_PUSH_BATCH,
  MAX_PUSH_BYTES,
  type BarrierRequest,
  type BarrierResponse,
  type ClearId,
  type ClearMarker,
  type HouseholdDevice,
  type PullResponse,
  type PushResponse,
  type PushResult,
} from '@bht/schema';

/**
 * Every request carries this phone's clear marker for the household (#85): null until the
 * household's first clear, undefined while the phone holds none. The server refuses a request
 * whose marker is not the household's with 409 `{cleared}`; see HttpError.cleared.
 */
export interface SyncTransport {
  push(events: BabyEvent[], clearId?: ClearMarker): Promise<PushResponse>;
  /** One page after `after`. Pass the first page's `through` on every later page of a pull. */
  pull(
    after: number,
    limit: number,
    through?: number,
    clearId?: ClearMarker,
  ): Promise<PullResponse>;
  /** Everything this phone held at `gen` is on the server (step 3b). */
  barrier(req: BarrierRequest): Promise<BarrierResponse>;
}

export class HttpError extends Error {
  /**
   * Set on a 409 whose body names the household's clear marker (#85): the household's data was
   * cleared and this phone has not seen it. The phone drops its copy and adopts the marker.
   * Undefined on every other error.
   */
  cleared: ClearId | undefined;

  constructor(
    readonly status: number,
    body?: unknown,
  ) {
    super(`HTTP ${status}`);
    this.cleared = clearedIn(status, body);
  }
}

/** Whether an error is the server refusing a request because the household was cleared. */
export function isCleared(e: unknown): e is HttpError & { cleared: ClearId } {
  return e instanceof HttpError && e.cleared !== undefined;
}

/**
 * Same-origin fetch transport; the session rides on an HttpOnly cookie. Pushes carry this
 * app's SCHEMA_VERSION. A server older than the app answers 409, which surfaces as an
 * HttpError, so the sync client backs off and every version stays pending. A null marker is
 * sent as absent: the server reads both as "no clear seen".
 */
export function httpTransport(base = ''): SyncTransport {
  async function call<T>(input: string, init?: RequestInit): Promise<T> {
    refuseSeeded(base + input);
    const res = await fetch(base + input, { credentials: 'same-origin', ...init });
    if (!res.ok) throw new HttpError(res.status, await res.json().catch(() => null));
    return (await res.json()) as T;
  }
  return {
    push: (events, clearId) =>
      call('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          events,
          ...(clearId && { clearId }),
        } satisfies PushRequest),
      }),
    pull: (after, limit, through, clearId) =>
      call(
        `/api/sync?after=${after}&limit=${limit}` +
          (through === undefined ? '' : `&through=${through}`) +
          (clearId ? `&clearId=${clearId}` : ''),
      ),
    barrier: (req) =>
      call('/api/sync/barrier', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      }),
  };
}
