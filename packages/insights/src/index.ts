import { SCHEMA_VERSION } from '@bht/schema';

/** The event schema version this insights engine understands. */
export const SUPPORTED_SCHEMA_VERSION = SCHEMA_VERSION;

export { evaluate, RED_FLAG_LOOKBACK_DAYS } from './evaluate.ts';
export { ENTRIES, type ThresholdEntry } from './entries.ts';
export * from './types.ts';
