import { SCHEMA_VERSION } from '@bht/schema';
import { expect, test } from 'vitest';
import { SUPPORTED_SCHEMA_VERSION } from './index.ts';

test('insights tracks the schema version', () => {
  expect(SUPPORTED_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
});
