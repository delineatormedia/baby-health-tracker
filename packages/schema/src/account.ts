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

/** POST /api/invites. */
export const Invite = v.strictObject({ code: InviteCode, expiresAt: Timestamp });

/** GET /api/household: what a joining phone adopts. */
export const HouseholdView = v.strictObject({
  id: Id,
  members: v.array(v.strictObject({ id: Id, displayName: DisplayName })),
  babies: v.array(Baby),
});

export type RegisterRequest = v.InferOutput<typeof RegisterRequest>;
export type JoinRequest = v.InferOutput<typeof JoinRequest>;
export type LoginRequest = v.InferOutput<typeof LoginRequest>;
export type CeremonyOptions = v.InferOutput<typeof CeremonyOptions>;
export type CeremonyResponse = v.InferOutput<typeof CeremonyResponse>;
export type SignedIn = v.InferOutput<typeof SignedIn>;
export type Invite = v.InferOutput<typeof Invite>;
export type HouseholdView = v.InferOutput<typeof HouseholdView>;

export const ACCOUNT_SCHEMAS = {
  RegisterRequest,
  JoinRequest,
  LoginRequest,
  CeremonyOptions,
  CeremonyResponse,
  SignedIn,
  Invite,
  HouseholdView,
};
