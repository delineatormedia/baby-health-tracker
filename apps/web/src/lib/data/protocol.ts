import {
  SCHEMA_VERSION,
  type BabyEvent,
  type PullResponse,
  type PushRequest,
  type PushResponse,
} from '@bht/schema';

// The /api/sync wire format lives in @bht/schema (protocol.ts), shared with the server.
export {
  MAX_PUSH_BATCH,
  MAX_PUSH_BYTES,
  type PullResponse,
  type PushResponse,
  type PushResult,
} from '@bht/schema';

export interface SyncTransport {
  push(events: BabyEvent[]): Promise<PushResponse>;
  /** One page after `after`. Pass the first page's `through` on every later page of a pull. */
  pull(after: number, limit: number, through?: number): Promise<PullResponse>;
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * Same-origin fetch transport; the session rides on an HttpOnly cookie. Pushes carry this
 * app's SCHEMA_VERSION. A server older than the app answers 409, which surfaces as an
 * HttpError, so the sync client backs off and every version stays pending.
 */
export function httpTransport(base = ''): SyncTransport {
  async function call<T>(input: string, init?: RequestInit): Promise<T> {
    const res = await fetch(base + input, { credentials: 'same-origin', ...init });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as T;
  }
  return {
    push: (events) =>
      call('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, events } satisfies PushRequest),
      }),
    pull: (after, limit, through) =>
      call(
        `/api/sync?after=${after}&limit=${limit}` +
          (through === undefined ? '' : `&through=${through}`),
      ),
  };
}
