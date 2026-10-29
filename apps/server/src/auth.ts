import {
  AddBaby,
  CeremonyResponse,
  JoinRequest,
  LoginRequest,
  newId,
  RegisterRequest,
  type Baby,
  type CeremonyOptions,
  type HouseholdView,
  type Invite,
  type SignedIn,
} from '@bht/schema';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';

/** Who is calling: the household every query is scoped to, and the member and phone. */
export interface Session {
  householdId: string;
  /** The signed-in member; absent only for sessions injected by tests. */
  memberId?: string;
  deviceId?: string;
}

/** Relying party settings, from BHT_RP_ID and BHT_ORIGIN in production. */
export interface AuthConfig {
  rpId: string;
  origin: string;
  rpName?: string;
  /** Secure cookie attribute; true unless a test or local HTTP dev turns it off. */
  secureCookie?: boolean;
}

export const SESSION_COOKIE = 'bht_session';
export const SESSION_DAYS = 180;
const FLOW_MINUTES = 5;
const INVITE_HOURS = 24;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type Purpose = 'register' | 'join' | 'login';

type FlowPayload =
  | { purpose: 'register'; request: RegisterRequest; userId: string }
  | { purpose: 'join'; request: JoinRequest; userId: string }
  | { purpose: 'login'; request: LoginRequest };

/** Outcome of a ceremony step: a body to answer with, or an HTTP error. */
export type Result<T> =
  { ok: true; value: T } | { ok: false; status: 400 | 401 | 404 | 409; error: string };

const fail = (status: 400 | 401 | 404 | 409, error: string) =>
  ({ ok: false, status, error }) as const;

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/**
 * Passkey ceremonies, invites and sessions over the server database. Every write that makes a
 * member, consumes an invite or issues a session is one transaction.
 */
export class Accounts {
  constructor(
    readonly db: DatabaseSync,
    readonly config: AuthConfig,
    readonly now: () => Date = () => new Date(),
  ) {}

  async registerOptions(input: unknown): Promise<Result<CeremonyOptions>> {
    const parsed = v.safeParse(RegisterRequest, input);
    if (!parsed.success) return fail(400, 'Expected { householdId, displayName, deviceId, baby }');
    const request = parsed.output;
    if (this.#exists('households', request.householdId)) return fail(409, 'Household exists');
    if (this.#exists('babies', request.baby.id)) return fail(409, 'Baby exists');
    const userId = randomBytes(16);
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName ?? 'Baby Health Tracker',
      rpID: this.config.rpId,
      userName: request.displayName,
      userID: userId,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const flowId = this.#startFlow(options.challenge, {
      purpose: 'register',
      request,
      userId: options.user.id,
    });
    return { ok: true, value: { flowId, options: asOptions(options) } };
  }

  async joinOptions(input: unknown): Promise<Result<CeremonyOptions>> {
    const parsed = v.safeParse(JoinRequest, input);
    if (!parsed.success) return fail(400, 'Expected { code, displayName, deviceId }');
    const request = parsed.output;
    if (!this.#openInvite(request.code)) return fail(404, 'Invite not found or expired');
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName ?? 'Baby Health Tracker',
      rpID: this.config.rpId,
      userName: request.displayName,
      userID: randomBytes(16),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const flowId = this.#startFlow(options.challenge, {
      purpose: 'join',
      request,
      userId: options.user.id,
    });
    return { ok: true, value: { flowId, options: asOptions(options) } };
  }

  async loginOptions(input: unknown): Promise<Result<CeremonyOptions>> {
    const parsed = v.safeParse(LoginRequest, input);
    if (!parsed.success) return fail(400, 'Expected { deviceId }');
    // Discoverable credentials: the phone offers its passkey, so no account name is asked for.
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: 'preferred',
    });
    const flowId = this.#startFlow(options.challenge, { purpose: 'login', request: parsed.output });
    return { ok: true, value: { flowId, options: asOptions(options) } };
  }

  /** Finishes a register or join ceremony: a new member with this passkey, signed in. */
  async registerVerify(
    input: unknown,
    purpose: 'register' | 'join',
  ): Promise<Result<SignedIn & { token: string }>> {
    const body = v.safeParse(CeremonyResponse, input);
    if (!body.success) return fail(400, 'Expected { flowId, response }');
    const flow = this.#takeFlow(body.output.flowId, purpose);
    if (!flow || flow.payload.purpose === 'login') return fail(401, 'Sign-in expired; start again');
    const payload = flow.payload;
    const verification = await verifyRegistrationResponse({
      response: body.output.response as unknown as RegistrationResponseJSON,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
      requireUserVerification: false,
    }).catch(() => null);
    if (!verification?.verified) return fail(401, 'Passkey not verified');
    const { credential } = verification.registrationInfo;

    const at = this.now().toISOString();
    // Member ids are ULIDs like every other id, minted here rather than on a phone.
    const memberId = newId();
    return this.#transaction(() => {
      let householdId: string;
      if (payload.purpose === 'register') {
        const { request } = payload;
        // Checked again here: another phone may have registered the same ids since options.
        if (this.#exists('households', request.householdId)) return fail(409, 'Household exists');
        if (this.#exists('babies', request.baby.id)) return fail(409, 'Baby exists');
        householdId = request.householdId;
        this.db
          .prepare('INSERT INTO households (id, created_at) VALUES (?, ?)')
          .run(householdId, at);
        const { id, name, birthAt, sex } = request.baby;
        this.db
          .prepare(
            `INSERT INTO babies (id, household_id, name, birth_at, sex, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, householdId, name, birthAt, sex, at);
      } else {
        const invite = this.#openInvite(payload.request.code);
        if (!invite) return fail(404, 'Invite not found or expired');
        householdId = invite.household_id;
      }
      if (this.#exists('credentials', credential.id))
        return fail(409, 'Passkey already registered');
      this.db
        .prepare(
          `INSERT INTO members (id, household_id, display_name, webauthn_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(memberId, householdId, payload.request.displayName, payload.userId, at);
      if (payload.purpose === 'join') {
        // Single use: only the first verify to get here consumes it.
        const used = this.db
          .prepare(
            `UPDATE invites SET used_at = ?, used_by = ?
             WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
          )
          .run(at, memberId, hashSecret(payload.request.code), at);
        if (used.changes !== 1) throw new Rollback(fail(404, 'Invite not found or expired'));
      }
      this.db
        .prepare(
          `INSERT INTO credentials (id, member_id, public_key, counter, transports, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          credential.id,
          memberId,
          credential.publicKey,
          credential.counter,
          JSON.stringify(credential.transports ?? []),
          at,
        );
      const token = this.#signIn(memberId, payload.request.deviceId, at);
      return { ok: true, value: { householdId, memberId, token } };
    });
  }

  /** Finishes a login: the member who owns this passkey, signed in on this phone. */
  async loginVerify(input: unknown): Promise<Result<SignedIn & { token: string }>> {
    const body = v.safeParse(CeremonyResponse, input);
    if (!body.success) return fail(400, 'Expected { flowId, response }');
    const flow = this.#takeFlow(body.output.flowId, 'login');
    if (!flow || flow.payload.purpose !== 'login') return fail(401, 'Sign-in expired; start again');
    const response = body.output.response as unknown as AuthenticationResponseJSON;
    const row = this.db
      .prepare(
        `SELECT c.id, c.public_key, c.counter, c.transports, c.member_id, m.household_id
         FROM credentials c JOIN members m ON m.id = c.member_id WHERE c.id = ?`,
      )
      .get(response.id) as
      | {
          id: string;
          public_key: Uint8Array;
          counter: number;
          transports: string;
          member_id: string;
          household_id: string;
        }
      | undefined;
    if (!row) return fail(401, 'Passkey not recognized');
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
      requireUserVerification: false,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: JSON.parse(row.transports) as AuthenticatorTransport[],
      },
    }).catch(() => null);
    if (!verification?.verified) return fail(401, 'Passkey not verified');
    const at = this.now().toISOString();
    return this.#transaction(() => {
      this.db
        .prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?')
        .run(verification.authenticationInfo.newCounter, at, row.id);
      const token = this.#signIn(row.member_id, flow.payload.request.deviceId, at);
      return {
        ok: true,
        value: { householdId: row.household_id, memberId: row.member_id, token },
      };
    });
  }

  /** The live session for a cookie token, or null. */
  session(token: string | undefined): Session | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT s.member_id, s.device_id, m.household_id
         FROM sessions s JOIN members m ON m.id = s.member_id
         JOIN devices d ON d.id = s.device_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
           AND d.removed_at IS NULL`,
      )
      .get(hashSecret(token), this.now().toISOString()) as
      { member_id: string; device_id: string; household_id: string } | undefined;
    if (!row) return null;
    return { householdId: row.household_id, memberId: row.member_id, deviceId: row.device_id };
  }

  signOut(token: string | undefined): void {
    if (!token) return;
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(this.now().toISOString(), hashSecret(token));
  }

  /** A single-use invite into the caller's household, valid for INVITE_HOURS. */
  createInvite(session: Required<Session>): Invite {
    const code = inviteCode();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + INVITE_HOURS * 3_600_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO invites (code_hash, household_id, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashSecret(code), session.householdId, session.memberId, now.toISOString(), expiresAt);
    return { code, expiresAt };
  }

  /**
   * Adds a baby to the caller's household. The same id again in this household answers the
   * stored baby (a retry after a lost response); an id held by another household is 409.
   */
  addBaby(householdId: string, input: unknown): Result<Baby> {
    const parsed = v.safeParse(AddBaby, input);
    if (!parsed.success) return fail(400, 'Expected { id, name, birthAt, sex }');
    const { id, name, birthAt, sex } = parsed.output;
    return this.#transaction(() => {
      const held = this.db.prepare('SELECT household_id FROM babies WHERE id = ?').get(id) as
        { household_id: string } | undefined;
      if (held && held.household_id !== householdId) return fail(409, 'Baby exists');
      if (!held) {
        this.db
          .prepare(
            `INSERT INTO babies (id, household_id, name, birth_at, sex, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, householdId, name, birthAt, sex, this.now().toISOString());
      }
      const baby = this.household(householdId).babies.find((b) => b.id === id)!;
      return { ok: true, value: baby };
    });
  }

  household(householdId: string): HouseholdView {
    const members = this.db
      .prepare(
        'SELECT id, display_name FROM members WHERE household_id = ? ORDER BY created_at, id',
      )
      .all(householdId) as { id: string; display_name: string }[];
    const babies = this.db
      .prepare(
        `SELECT id, name, birth_at, sex FROM babies WHERE household_id = ?
         ORDER BY created_at, id`,
      )
      .all(householdId) as { id: string; name: string; birth_at: string; sex: string }[];
    return {
      id: householdId,
      members: members.map((m) => ({ id: m.id, displayName: m.display_name })),
      babies: babies.map((b) => ({
        id: b.id,
        householdId,
        name: b.name,
        birthAt: b.birth_at,
        sex: b.sex as HouseholdView['babies'][number]['sex'],
      })),
    };
  }

  /**
   * Records the phone for the member (a phone belongs to whoever last signed in on it) and
   * issues a session. Returns the token; only its hash is stored.
   */
  #signIn(memberId: string, deviceId: string, at: string): string {
    // A removed phone stays removed (step 3b counts removal as the vouch from removedAt); it
    // cannot sign itself back in under the same device id.
    const removed = this.db
      .prepare('SELECT 1 FROM devices WHERE id = ? AND removed_at IS NOT NULL')
      .get(deviceId);
    if (removed) throw new Rollback(fail(401, 'This phone was removed from the household'));
    this.db
      .prepare(
        `INSERT INTO devices (id, member_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET member_id = excluded.member_id,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(deviceId, memberId, at, at);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.parse(at) + SESSION_DAYS * 86_400_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, member_id, device_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashSecret(token), memberId, deviceId, at, expires);
    return token;
  }

  #startFlow(challenge: string, payload: FlowPayload): string {
    const id = randomUUID();
    const now = this.now();
    this.db.prepare('DELETE FROM auth_flows WHERE expires_at <= ?').run(now.toISOString());
    this.db
      .prepare(
        'INSERT INTO auth_flows (id, challenge, purpose, payload, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        id,
        challenge,
        payload.purpose,
        JSON.stringify(payload),
        new Date(now.getTime() + FLOW_MINUTES * 60_000).toISOString(),
      );
    return id;
  }

  /** Removes and returns a live flow: each challenge is answered at most once. */
  #takeFlow(id: string, purpose: Purpose): { challenge: string; payload: FlowPayload } | null {
    const row = this.db
      .prepare(
        `DELETE FROM auth_flows WHERE id = ? AND purpose = ? AND expires_at > ?
         RETURNING challenge, payload`,
      )
      .get(id, purpose, this.now().toISOString()) as
      { challenge: string; payload: string } | undefined;
    if (!row) return null;
    return { challenge: row.challenge, payload: JSON.parse(row.payload) as FlowPayload };
  }

  #openInvite(code: string): { household_id: string } | null {
    const row = this.db
      .prepare(
        `SELECT household_id FROM invites
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(hashSecret(code), this.now().toISOString()) as { household_id: string } | undefined;
    return row ?? null;
  }

  #exists(table: 'households' | 'babies' | 'credentials', id: string): boolean {
    return this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  }

  #transaction<T>(fn: () => Result<T>): Result<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      if (e instanceof Rollback) return e.result as Result<T>;
      throw e;
    }
  }
}

/** simplewebauthn's options JSON, as the wire schema's open object. */
const asOptions = (options: { challenge: string }) => options as CeremonyOptions['options'];

/** Thrown inside a transaction to undo its writes and answer with an error. */
class Rollback {
  constructor(readonly result: Result<never>) {}
}

function inviteCode(): string {
  const bytes = randomBytes(10);
  return [...bytes].map((b) => CROCKFORD[b & 31]).join('');
}
