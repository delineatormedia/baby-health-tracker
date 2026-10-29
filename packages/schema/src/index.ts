/**
 * Version of the wire format: BabyEvent, the /api/sync protocol and the account routes
 * (account.ts). Bumped on every change to any of them, additive or not, refinements included: the server answers 409 to a client whose
 * version is newer than its own (protocol.ts), and schema-version.test.ts fails if a wire
 * schema changes without a bump.
 */
export const SCHEMA_VERSION = 4;

export * from './events.ts';
export * from './model.ts';
export * from './units.ts';
export * from './sync.ts';
export * from './protocol.ts';
export * from './account.ts';
export * from './refusals.ts';
