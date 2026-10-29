import { expect, test } from 'vitest';
import { SCHEMA_VERSION } from './index.ts';

test('schema version is a positive integer', () => {
  expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  expect(SCHEMA_VERSION).toBeGreaterThan(0);
});
