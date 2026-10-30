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
import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { HttpError } from './protocol.ts';
import { SEEDED_REFUSAL, SeededRefusal, refuseSeeded } from './seeded.ts';

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
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

/** Same-origin fetch; the session and the flow cookie ride along as HttpOnly cookies. */
export function httpAccount(base = ''): AccountTransport {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    refuseSeeded(base + path);
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
    post: (path, body, signal) =>
      call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
  };
}

/** navigator.credentials, as WebAuthn JSON in and out. */
export interface Passkeys {
  create(options: CeremonyOptions['options'], signal?: AbortSignal): Promise<unknown>;
  get(options: CeremonyOptions['options'], signal?: AbortSignal): Promise<unknown>;
}

/**
 * The browser's passkey prompts. The server's options are WebAuthn JSON already. An abort
 * closes the open prompt; the library holds one ceremony at a time.
 */
export function browserPasskeys(): Passkeys {
  async function prompt(run: () => Promise<unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const cancel = () => WebAuthnAbortService.cancelCeremony();
    signal?.addEventListener('abort', cancel);
    try {
      return await run();
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    create: (options, signal) =>
      prompt(() => startRegistration({ optionsJSON: options as never }), signal),
    get: (options, signal) =>
      prompt(() => startAuthentication({ optionsJSON: options as never }), signal),
  };
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
 *
 * An aborted ceremony (a sign-out came) stops before its next step: no prompt, no verify, no
 * retry. Verify itself is never aborted once sent; see #once.
 */
export class Account {
  constructor(
    readonly http: AccountTransport,
    readonly passkeys: Passkeys,
    readonly device: DeviceId,
  ) {}

  /** Creates the household around this phone's baby; the first member is signed in. */
  register(request: Omit<RegisterRequest, 'deviceId'>, signal?: AbortSignal): Promise<SignedIn> {
    return this.#ceremony('register', (deviceId) => ({ ...request, deviceId }), signal);
  }

  /** Joins a household with an invite code. */
  join(request: Omit<JoinRequest, 'deviceId'>, signal?: AbortSignal): Promise<SignedIn> {
    return this.#ceremony('join', (deviceId) => ({ ...request, deviceId }), signal);
  }

  /** Signs in with a passkey this phone already holds. */
  login(signal?: AbortSignal): Promise<SignedIn> {
    return this.#ceremony('login', (deviceId) => ({ deviceId }), signal);
  }

  /**
   * Ends this phone's session. `gen` says it stopped writing and its barrier covered that write
   * generation, so the household stops waiting for it (step 3b).
   */
  async logout(gen?: number): Promise<void> {
    await this.http.post('/api/auth/logout', gen === undefined ? {} : { gen });
  }

  /** Removes another phone of the household (step 3b). Resolves to its removal time (ms). */
  removeDevice(deviceId: string): Promise<{ removedAt: number }> {
    return this.http.post('/api/devices/remove', { deviceId });
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

  async #ceremony(
    kind: Kind,
    body: (deviceId: string) => unknown,
    signal?: AbortSignal,
  ): Promise<SignedIn> {
    try {
      return await this.#once(kind, body(this.device.get()), signal);
    } catch (e) {
      if (!isDeviceRefusal(e)) throw e;
      signal?.throwIfAborted();
      return this.#once(kind, body(this.device.mint()), signal);
    }
  }

  async #once(kind: Kind, request: unknown, signal?: AbortSignal): Promise<SignedIn> {
    signal?.throwIfAborted();
    const { flowId, options } = await this.http.post<CeremonyOptions>(
      `/api/auth/${kind}/options`,
      request,
      signal,
    );
    signal?.throwIfAborted();
    const response =
      kind === 'login'
        ? await this.passkeys.get(options, signal)
        : await this.passkeys.create(options, signal);
    signal?.throwIfAborted();
    // Not aborted from here: verify's Set-Cookie lands whatever the page does, so the caller
    // waits for it and a sign-out behind it revokes that session too.
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
  if (e instanceof SeededRefusal) return `${SEEDED_REFUSAL}. Clear local data to sign in.`;
  if (e instanceof Error && e.name === 'NotAllowedError') return 'Passkey cancelled. Try again.';
  if (e instanceof TypeError) return 'No connection to the server. Try again.';
  return e instanceof Error ? e.message : String(e);
}
