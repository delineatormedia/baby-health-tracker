import * as v from 'valibot';
import { Baby, Id, Member, Timestamp } from './model.ts';

// Wire format for passkey sign-in, households and invites (#5 step 2), shared by the server
// and the web client. These are wire schemas: changing one bumps SCHEMA_VERSION.

/** Ten Crockford base32 characters, about 50 bits: single-use and short-lived. */
export const InviteCode = v.pipe(
  v.string(),
  v.regex(/^[0-9A-HJKMNP-TV-Z]{10}$/, 'Expected a 10-character invite code'),
);

const DisplayName = Member.entries.displayName;

/** The phone's baby as the household adopts it: the local record, householdId aside. */
export const NewBaby = v.omit(Baby, ['householdId']);

/**
 * POST /api/auth/register/options. The first member creates the household. Its id and its
 * baby are the phone's own local ids, so entries logged before sign-in keep their babyId.
 * deviceId is the phone's authorId.
 */
export const RegisterRequest = v.strictObject({
  householdId: Id,
  displayName: DisplayName,
  deviceId: Id,
  baby: NewBaby,
});

/** POST /api/auth/join/options: a second member, by invite. */
export const JoinRequest = v.strictObject({
  code: InviteCode,
  displayName: DisplayName,
  deviceId: Id,
});

/** POST /api/auth/login/options: a returning member on this phone. */
export const LoginRequest = v.strictObject({ deviceId: Id });

/**
 * Every …/options answer: the WebAuthn options for navigator.credentials, and the flow they
 * belong to. The flow is single-use and expires after a few minutes.
 */
export const CeremonyOptions = v.strictObject({
  flowId: v.string(),
  options: v.looseObject({ challenge: v.string() }),
});

/** Every …/verify body: the flow, and the credential JSON the browser returned. */
export const CeremonyResponse = v.strictObject({
  flowId: v.string(),
  response: v.looseObject({ id: v.string(), type: v.literal('public-key') }),
});

/** A successful …/verify. The session itself is an HttpOnly cookie. */
export const SignedIn = v.strictObject({ householdId: Id, memberId: Id });

/**
 * The household's clear marker, as a phone holds it (#85). Null until the household's first
 * clear; after that the ULID of the latest clear, minted on the server. Every sync request
 * carries the phone's copy (ClearMarker). The server refuses the whole request with 409
 * `{cleared}` (ClearedRefusal) when it differs from the household's: a phone that has not
 * seen the latest clear can neither upload nor read until it drops its data. A request without
 * one (an app from before #85) is treated as holding null.
 */
export const ClearId = v.nullable(Id);
export const ClearMarker = v.optional(ClearId);

/**
 * POST /api/babies: a baby this phone created after sign-up (a second child, say), so its
 * entries are not refused as Unknown baby. Retrying with the same id is safe.
 */
export const AddBaby = v.strictObject({ ...NewBaby.entries, clearId: ClearMarker });

/** POST /api/invites. */
export const Invite = v.strictObject({ code: InviteCode, expiresAt: Timestamp });

/** GET /api/household: what a joining phone adopts, its clear marker included. */
export const HouseholdView = v.strictObject({
  id: Id,
  members: v.array(v.strictObject({ id: Id, displayName: DisplayName })),
  babies: v.array(Baby),
  clearId: ClearId,
});

/**
 * POST /api/household/clear (#85): deletes the household's babies and every stored version of
 * their entries, on the server, for good. clearId is the marker the phone holds; the clear
 * runs only if it is the household's current one, so a phone that missed an earlier clear
 * cannot clear data it has never seen. The household, its members, passkeys and phones stay.
 */
export const ClearRequest = v.strictObject({ clearId: ClearId });

/** The new marker and when the clear ran. The marker is a ULID, so it carries that time too. */
export const ClearResponse = v.strictObject({ clearId: Id, clearedAt: Timestamp });

/**
 * The 409 every sync route answers with when the request's marker is not the household's.
 * `cleared` is the household's current marker; the phone drops its local data and adopts it.
 */
export const ClearedRefusal = v.strictObject({ error: v.string(), cleared: ClearId });

export type RegisterRequest = v.InferOutput<typeof RegisterRequest>;
export type JoinRequest = v.InferOutput<typeof JoinRequest>;
export type LoginRequest = v.InferOutput<typeof LoginRequest>;
export type CeremonyOptions = v.InferOutput<typeof CeremonyOptions>;
export type CeremonyResponse = v.InferOutput<typeof CeremonyResponse>;
export type SignedIn = v.InferOutput<typeof SignedIn>;
export type AddBaby = v.InferOutput<typeof AddBaby>;
export type Invite = v.InferOutput<typeof Invite>;
export type HouseholdView = v.InferOutput<typeof HouseholdView>;
export type ClearId = v.InferOutput<typeof ClearId>;
export type ClearMarker = v.InferOutput<typeof ClearMarker>;
export type ClearRequest = v.InferOutput<typeof ClearRequest>;
export type ClearResponse = v.InferOutput<typeof ClearResponse>;
export type ClearedRefusal = v.InferOutput<typeof ClearedRefusal>;

export const ACCOUNT_SCHEMAS = {
  AddBaby,
  RegisterRequest,
  JoinRequest,
  LoginRequest,
  CeremonyOptions,
  CeremonyResponse,
  SignedIn,
  Invite,
  HouseholdView,
  ClearRequest,
  ClearResponse,
  ClearedRefusal,
};
