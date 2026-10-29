import {
  DEVICE_ELSEWHERE,
  DEVICE_REMOVED,
  type Baby,
  type CeremonyOptions,
  type HouseholdView,
  type Invite,
  type JoinRequest,
  type RegisterRequest,
  type SignedIn,
} from '@bht/schema';
import { HttpError } from './protocol.ts';

/** A refused account request, with the server's reason ("Invite not found or expired"). */
export class AccountError extends HttpError {
  constructor(
    status: number,
    readonly reason: string,
  ) {
    super(status);
    this.message = reason;
  }
}

/** The account routes' HTTP calls. Every POST is JSON, so the server's 415 rule holds. */
export interface AccountTransport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/** Same-origin fetch; the session and the flow cookie ride along as HttpOnly cookies. */
export function httpAccount(base = ''): AccountTransport {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(base + path, { credentials: 'same-origin', ...init });
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (!res.ok) {
      const reason = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
      throw new AccountError(res.status, reason);
    }
    return body as T;
  }
  return {
    get: (path) => call(path),
    post: (path, body) =>
      call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

/** navigator.credentials, as WebAuthn JSON in and out. */
export interface Passkeys {
  create(options: CeremonyOptions['options']): Promise<unknown>;
  get(options: CeremonyOptions['options']): Promise<unknown>;
}

/** This phone's device id (its authorId), and a way to replace it with a fresh one. */
export interface DeviceId {
  get(): string;
  mint(): string;
}

type Kind = 'register' | 'join' | 'login';

/**
 * Passkey sign-in, households and invites from the phone (#5 step 3). Each ceremony is
 * options, then the passkey prompt, then verify, one at a time: a new options call replaces
 * the browser's flow cookie.
 *
 * A phone id the server will not take (removed from the household, or held by another one)
 * is replaced with a fresh id and the ceremony runs again, so the parent never hits a dead
 * end. Register and join are refused at options, before a passkey is made; a login only at
 * verify, so it prompts for the passkey a second time.
 */
export class Account {
  constructor(
    readonly http: AccountTransport,
    readonly passkeys: Passkeys,
    readonly device: DeviceId,
  ) {}

  /** Creates the household around this phone's baby; the first member is signed in. */
  register(request: Omit<RegisterRequest, 'deviceId'>): Promise<SignedIn> {
    return this.#ceremony('register', (deviceId) => ({ ...request, deviceId }));
  }

  /** Joins a household with an invite code. */
  join(request: Omit<JoinRequest, 'deviceId'>): Promise<SignedIn> {
    return this.#ceremony('join', (deviceId) => ({ ...request, deviceId }));
  }

  /** Signs in with a passkey this phone already holds. */
  login(): Promise<SignedIn> {
    return this.#ceremony('login', (deviceId) => ({ deviceId }));
  }

  async logout(): Promise<void> {
    await this.http.post('/api/auth/logout', {});
  }

  household(): Promise<HouseholdView> {
    return this.http.get('/api/household');
  }

  /** Adds a baby this phone made after sign-up. The same id again is a safe retry. */
  addBaby(baby: Omit<Baby, 'householdId'>): Promise<Baby> {
    const { id, name, birthAt, sex } = baby;
    return this.http.post('/api/babies', { id, name, birthAt, sex });
  }

  invite(): Promise<Invite> {
    return this.http.post('/api/invites', {});
  }

  async #ceremony(kind: Kind, body: (deviceId: string) => unknown): Promise<SignedIn> {
    try {
      return await this.#once(kind, body(this.device.get()));
    } catch (e) {
      if (!isDeviceRefusal(e)) throw e;
      return this.#once(kind, body(this.device.mint()));
    }
  }

  async #once(kind: Kind, request: unknown): Promise<SignedIn> {
    const { flowId, options } = await this.http.post<CeremonyOptions>(
      `/api/auth/${kind}/options`,
      request,
    );
    const response =
      kind === 'login' ? await this.passkeys.get(options) : await this.passkeys.create(options);
    return this.http.post<SignedIn>(`/api/auth/${kind}/verify`, { flowId, response });
  }
}

/** The two refusals a new device id fixes. */
export function isDeviceRefusal(e: unknown): boolean {
  return (
    e instanceof AccountError &&
    ((e.status === 401 && e.reason === DEVICE_REMOVED) ||
      (e.status === 409 && e.reason === DEVICE_ELSEWHERE))
  );
}

/**
 * What a failed sign-in says to the parent. A dismissed or timed-out passkey prompt is a
 * NotAllowedError, which browsers word for developers.
 */
export function signInFailure(e: unknown): string {
  if (e instanceof AccountError) return e.reason;
  if (e instanceof Error && e.name === 'NotAllowedError') return 'Passkey cancelled. Try again.';
  if (e instanceof TypeError) return 'No connection to the server. Try again.';
  return e instanceof Error ? e.message : String(e);
}
