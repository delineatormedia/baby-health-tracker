import {
  newId,
  SCHEMA_VERSION,
  type CeremonyOptions,
  type PullResponse,
  type PushResponse,
} from '@bht/schema';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { expect } from 'vitest';
import type { createApp } from '../app.ts';
import { FLOW_COOKIE } from '../auth.ts';
import { SoftAuthenticator } from './authenticator.ts';

type App = ReturnType<typeof createApp>;

/**
 * A phone: its passkey authenticator, its local ids, and the cookies its browser holds (the
 * session, and the flow cookie of a ceremony in progress). Requests come from the app's origin.
 */
export class Phone {
  readonly passkeys: SoftAuthenticator;
  readonly deviceId = newId();
  /** The session cookie as `bht_session=<token>`, or null when signed out. */
  cookie: string | null = null;
  /** The last Set-Cookie line for the session. */
  setCookie: string | null = null;
  flow: string | null = null;

  constructor(
    readonly app: App,
    readonly origin: string,
  ) {
    this.passkeys = new SoftAuthenticator(origin);
  }

  async request(path: string, body?: unknown) {
    const sent: Record<string, string> = {};
    if (body !== undefined) {
      sent['content-type'] = 'application/json';
      sent.origin = this.origin;
    }
    const jar = [this.cookie, this.flow].filter(Boolean).join('; ');
    if (jar) sent.cookie = jar;
    const res = await this.app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: sent,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const set of res.headers.getSetCookie()) {
      const pair = set.split(';')[0]!;
      const value = pair.endsWith('=') ? null : pair;
      if (pair.startsWith(`${FLOW_COOKIE}=`)) this.flow = value;
      else {
        this.setCookie = set;
        this.cookie = value;
      }
    }
    return res;
  }

  async json<T>(path: string, body?: unknown, status = 200): Promise<T> {
    const res = await this.request(path, body);
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(status);
    return (await res.json()) as T;
  }

  /** Options, then the authenticator, then verify: one passkey ceremony. */
  async ceremony(kind: 'register' | 'join' | 'login', request: unknown) {
    const { flowId, options } = await this.json<CeremonyOptions>(
      `/api/auth/${kind}/options`,
      request,
    );
    const response =
      kind === 'login'
        ? this.passkeys.get(options as unknown as PublicKeyCredentialRequestOptionsJSON)
        : this.passkeys.create(options as unknown as PublicKeyCredentialCreationOptionsJSON);
    return {
      flowId,
      response,
      verify: () => this.request(`/api/auth/${kind}/verify`, { flowId, response }),
    };
  }

  push(events: unknown[]) {
    return this.json<PushResponse>('/api/sync', { schemaVersion: SCHEMA_VERSION, events });
  }

  pull() {
    return this.json<PullResponse>('/api/sync?after=0&limit=1000');
  }
}

export function newHousehold() {
  return {
    householdId: newId(),
    displayName: 'Maya',
    baby: { id: newId(), name: 'Pip', birthAt: '2026-10-20T08:15:00.000Z', sex: 'female' as const },
  };
}

/** A new household, its first member signed in on a new phone. */
export async function register(app: App, origin: string) {
  const phone = new Phone(app, origin);
  const home = newHousehold();
  const { verify } = await phone.ceremony('register', { ...home, deviceId: phone.deviceId });
  const res = await verify();
  expect(res.status).toBe(200);
  return { phone, home, signedIn: (await res.json()) as { householdId: string; memberId: string } };
}
