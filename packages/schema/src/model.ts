import * as v from 'valibot';
import { monotonicFactory } from 'ulid';

/**
 * Crockford base32 ULID: 26 chars, sortable by creation time. Ids are created on the client.
 * The first char is 0-7 because the 48-bit timestamp overflows above 7ZZZZZZZZZ.
 */
export const Id = v.pipe(v.string(), v.regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'Expected a ULID'));
export type Id = v.InferOutput<typeof Id>;

// Monotonic so ids minted in the same millisecond still sort in creation order.
const ulid = monotonicFactory();

export function newId(): Id {
  return ulid();
}

/**
 * UTC timestamp in the exact form Date.prototype.toISOString() produces
 * ("2026-10-29T03:00:00.000Z"). One fixed form keeps timestamps sortable as strings.
 */
export const Timestamp = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'Expected a UTC ISO timestamp'),
  v.check((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s, 'Invalid date'),
);
export type Timestamp = v.InferOutput<typeof Timestamp>;

export const Household = v.strictObject({
  id: Id,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
});
export type Household = v.InferOutput<typeof Household>;

export const Member = v.strictObject({
  id: Id,
  householdId: Id,
  displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
});
export type Member = v.InferOutput<typeof Member>;

/** Sex at birth; growth standards (WHO) are sex-specific, so insights need it when known. */
export const Sex = v.picklist(['female', 'male', 'unspecified']);
export type Sex = v.InferOutput<typeof Sex>;

export const Baby = v.strictObject({
  id: Id,
  householdId: Id,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  birthAt: Timestamp,
  sex: Sex,
});
export type Baby = v.InferOutput<typeof Baby>;

/** Validates an untrusted baby record (local storage, sync). null if it is not a valid baby. */
export function parseBaby(input: unknown): Baby | null {
  const r = v.safeParse(Baby, input);
  return r.success ? r.output : null;
}
