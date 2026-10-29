/**
 * Version of the wire format: BabyEvent and the /api/sync protocol. Bumped on every change to
 * either, additive or not, refinements included: the server answers 409 to a client whose
 * version is newer than its own (protocol.ts), and schema-version.test.ts fails if a wire
 * schema changes without a bump.
 */
export const SCHEMA_VERSION = 2;

export * from './events.ts';
export * from './model.ts';
export * from './units.ts';
export * from './sync.ts';
export * from './protocol.ts';
