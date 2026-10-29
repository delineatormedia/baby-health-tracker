import { parseEvent, resolveCurrent, type BabyEvent, type StoredVersion } from '@bht/schema';
import {
  HttpError,
  type PullResponse,
  type PushResponse,
  type PushResult,
  type SyncTransport,
} from '../protocol.ts';

/** In-memory implementation of the /api/sync contract, for client tests. */
export class FakeServer {
  readonly log: { seq: number; event: BabyEvent }[] = [];
  #seq = 0;

  push(events: unknown[]): PushResponse {
    return { results: events.map((e) => this.#accept(e)) };
  }

  pull(after: number, limit: number, through = this.#seq): PullResponse {
    const page = this.log.filter((v) => v.seq > after && v.seq <= through).slice(0, limit);
    const next = page.at(-1)?.seq ?? after;
    return {
      versions: page,
      next,
      more: this.log.some((v) => v.seq > next && v.seq <= through),
      through,
    };
  }

  current(id: string): BabyEvent | undefined {
    return resolveCurrent(this.log.filter((v) => v.event.id === id) as StoredVersion[])?.event;
  }

  #accept(input: unknown): PushResult {
    const raw = input as { id?: string; version?: number };
    const parsed = parseEvent(input);
    if (!parsed.ok) {
      return {
        id: String(raw.id),
        version: Number(raw.version),
        status: 'rejected',
        error: parsed.errors[0] ?? 'invalid',
      };
    }
    const event = parsed.value;
    const same = this.log.filter((v) => v.event.id === event.id);
    const body = JSON.stringify(event);
    const dup = same.find(
      (v) => v.event.version === event.version && JSON.stringify(v.event) === body,
    );
    if (dup) return { id: event.id, version: event.version, seq: dup.seq, status: 'duplicate' };
    const stored = { seq: ++this.#seq, event };
    this.log.push(stored);
    const winner = resolveCurrent([...same, stored]);
    const status = winner === stored ? 'accepted' : 'superseded';
    return { id: event.id, version: event.version, seq: stored.seq, status };
  }
}

/** A transport to a FakeServer that can be switched offline or made to lose responses. */
export class FakeTransport implements SyncTransport {
  online = true;
  /** Pushes work but pulls fail, as when the connection drops mid-sync. */
  failPulls = false;
  /** When set, the server applies the next push but the response is lost. */
  dropNextPushResponse = false;
  status: number | null = null;
  pushes = 0;

  constructor(readonly server: FakeServer) {}

  async push(events: BabyEvent[]): Promise<PushResponse> {
    this.#check();
    this.pushes += 1;
    const res = this.server.push(structuredClone(events));
    if (this.dropNextPushResponse) {
      this.dropNextPushResponse = false;
      throw new TypeError('network connection lost');
    }
    return structuredClone(res);
  }

  /** Pull requests as sent, so tests can check the through a pull carries. */
  readonly pulls: { after: number; limit: number; through?: number }[] = [];
  /** Runs after each pull is answered, as when another phone pushes between pages. */
  afterPull: (() => void) | null = null;

  async pull(after: number, limit: number, through?: number): Promise<PullResponse> {
    this.#check();
    if (this.failPulls) throw new TypeError('network connection lost');
    this.pulls.push({ after, limit, through });
    const page = structuredClone(this.server.pull(after, limit, through));
    this.afterPull?.();
    return page;
  }

  #check() {
    if (!this.online) throw new TypeError('Failed to fetch');
    if (this.status !== null) throw new HttpError(this.status);
  }
}
