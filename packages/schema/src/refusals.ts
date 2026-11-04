import * as v from 'valibot';
import { ClearedRefusal, type ClearId } from './account.ts';

// Sign-in refusals the web client acts on rather than only shows (#5 step 3). The server
// answers with exactly these texts, and the client matches them to mint a new device id, so
// both import them from here. They are not wire schemas and do not change SCHEMA_VERSION.

/** 401 from a sign-in with a phone id a parent removed from the household. */
export const DEVICE_REMOVED = 'This phone was removed from the household';

/** 409 from a sign-in with a phone id another household holds. */
export const DEVICE_ELSEWHERE = 'This phone id belongs to another household';

/**
 * The household's clear marker from a 409 `{error, cleared}` answer (#85, ClearedRefusal), or
 * undefined for any other status or body. Every sync route answers this way when the request's
 * marker is not the household's; the client drops its copy and adopts the marker.
 */
export function clearedIn(status: number, body: unknown): ClearId | undefined {
  if (status !== 409 || !v.is(ClearedRefusal, body)) return undefined;
  return body.cleared;
}
