import * as v from 'valibot';
import { ACCOUNT_SCHEMAS } from './account.ts';
import { BabyEvent } from './events.ts';
import { Id } from './model.ts';

// Wire format for /api/sync (#5), shared by the server and the web sync client. These are
// wire schemas: changing one bumps SCHEMA_VERSION (schema-version.test.ts).

export const MAX_PUSH_BATCH = 500;
export const MAX_PULL_LIMIT = 1000;
/**
 * Largest push body the server reads, in bytes. 500 valid versions can exceed it (2,000
 * characters of CJK notes are 6,000 UTF-8 bytes each), so clients batch by bytes as well as
 * by count.
 */
export const MAX_PUSH_BYTES = 2 * 1024 * 1024;

const Seq = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const Cursor = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** A time on the server's clock, in epoch ms. Watermarks are compared against it (step 3b). */
const ServerMs = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/**
 * POST /api/sync body. schemaVersion is the client's SCHEMA_VERSION. A server older than the
 * client answers 409 { upgrade: true } for the whole batch and stores nothing, so the client
 * keeps every version pending instead of having it rejected by an outdated schema. Events are
 * checked one by one with parseEvent, so one invalid version is rejected on its own.
 */
export const PushRequest = v.strictObject({
  schemaVersion: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  events: v.pipe(v.array(v.unknown()), v.maxLength(MAX_PUSH_BATCH)),
});
export type PushRequest = Omit<v.InferOutput<typeof PushRequest>, 'events'> & {
  events: BabyEvent[];
};

/** Checks a push body's envelope. Each event still goes through parseEvent on its own. */
export function isPushRequestBody(input: unknown): input is v.InferOutput<typeof PushRequest> {
  return v.is(PushRequest, input);
}

export const PushResult = v.variant('status', [
  v.strictObject({
    id: v.string(),
    version: v.number(),
    seq: Seq,
    status: v.picklist(['accepted', 'duplicate', 'superseded']),
  }),
  v.strictObject({
    id: v.string(),
    version: v.number(),
    status: v.literal('rejected'),
    error: v.string(),
  }),
]);
export type PushResult = v.InferOutput<typeof PushResult>;

/** serverNow is the server's clock when it answered (step 3b); the barrier's `at` comes from it. */
export const PushResponse = v.strictObject({
  results: v.array(PushResult),
  serverNow: v.optional(ServerMs),
});
export type PushResponse = v.InferOutput<typeof PushResponse>;

/**
 * One phone of the household, as a pull's first page reports it (step 3b). watermark is the
 * server time W(D) before which every entry the phone recorded is on the server, null until
 * its first barrier. lastSeenAt is its last sign-in or barrier. Server clock, epoch ms.
 */
export const HouseholdDevice = v.strictObject({
  deviceId: Id,
  memberName: v.string(),
  watermark: v.nullable(ServerMs),
  lastSeenAt: ServerMs,
  removedAt: v.nullable(ServerMs),
});
export type HouseholdDevice = v.InferOutput<typeof HouseholdDevice>;

/**
 * GET /api/sync?after=&limit=&through= response. The first page of a pull sends no through;
 * the server reads the household's highest seq in the same snapshot as the page and returns
 * it. Later pages send it back and get only seq <= through, so a push landing mid-pull cannot
 * stretch the pull. more is false once a page reaches through.
 *
 * Every page carries serverNow. The first page also carries the household's devices, read in
 * the same snapshot as through: a barrier is stored only after its versions, so a watermark it
 * shows covers nothing past through. A client adopts the list with the page that reaches
 * through, and keeps the first page's serverNow as its clock sample for the whole pull.
 */
export const PullResponse = v.strictObject({
  versions: v.array(v.strictObject({ seq: Seq, event: BabyEvent })),
  next: Cursor,
  more: v.boolean(),
  through: Cursor,
  serverNow: v.optional(ServerMs),
  devices: v.optional(v.array(HouseholdDevice)),
});
export type PullResponse = v.InferOutput<typeof PullResponse>;

/**
 * POST /api/sync/barrier (step 3b). Every version this phone held at write generation `gen` is
 * on the server, and `at` is a serverNow it received before reading them. The server sets the
 * device's watermark to max(watermark, min(at, its own now)): it never moves back, so a late or
 * replayed barrier is harmless. deviceId must be the session's own device.
 */
export const BarrierRequest = v.strictObject({ deviceId: Id, gen: Cursor, at: ServerMs });
export type BarrierRequest = v.InferOutput<typeof BarrierRequest>;

export const BarrierResponse = v.strictObject({ watermark: ServerMs, serverNow: ServerMs });
export type BarrierResponse = v.InferOutput<typeof BarrierResponse>;

/** Every wire schema SCHEMA_VERSION covers. */
export const WIRE_SCHEMAS = {
  BabyEvent,
  PushRequest,
  PushResponse,
  PullResponse,
  BarrierRequest,
  BarrierResponse,
  ...ACCOUNT_SCHEMAS,
};
