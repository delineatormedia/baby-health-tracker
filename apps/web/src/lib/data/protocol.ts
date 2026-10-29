import type { BabyEvent } from '@bht/schema';

// Wire format for /api/sync, as proposed for #5. Moves to @bht/schema once the server agrees.

export const MAX_PUSH_BATCH = 500;

export type PushResult =
  | { id: string; version: number; seq: number; status: 'accepted' | 'duplicate' | 'superseded' }
  | { id: string; version: number; status: 'rejected'; error: string };

export interface PushResponse {
  results: PushResult[];
}

export interface PullResponse {
  versions: { seq: number; event: BabyEvent }[];
  next: number;
  more: boolean;
}

export interface SyncTransport {
  push(events: BabyEvent[]): Promise<PushResponse>;
  pull(after: number, limit: number): Promise<PullResponse>;
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** Same-origin fetch transport; the session rides on an HttpOnly cookie. */
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
        body: JSON.stringify({ events }),
      }),
    pull: (after, limit) => call(`/api/sync?after=${after}&limit=${limit}`),
  };
}
