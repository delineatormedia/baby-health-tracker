import * as v from 'valibot';
import { expect, test } from 'vitest';
import { SCHEMA_VERSION, WIRE_SCHEMAS } from './index.ts';

/**
 * Fingerprint of every wire schema (BabyEvent and the /api/sync protocol) per SCHEMA_VERSION,
 * append-only. When a schema changes, bump SCHEMA_VERSION and add a line here; never edit an
 * existing line. Version 1 predates this test (it covered the event types before #19, #22,
 * #24 and #29 added fields, and had no shared protocol).
 */
const FINGERPRINTS: Record<number, string> = {
  2: 'e198b0e7c82b1bc7',
};

/**
 * Hashes a valibot schema tree: every kind, type, key, option, literal, bound and check,
 * including each check's source text, so editing a refinement's logic moves it too. Runs of
 * whitespace in that source count as one space. Internals (functions valibot adds to run a
 * schema) are left out, so the hash moves only when what the schema accepts may have moved.
 */
function fingerprint(schema: unknown): string {
  const skip = new Set(['reference', 'async', '~run', '~standard', '~types']);
  const walk = (x: unknown): unknown => {
    if (typeof x === 'function') return x.toString().replace(/\s+/g, ' ');
    if (x instanceof RegExp) return x.toString();
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x)
          .filter(([k]) => !skip.has(k))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, walk(v)]),
      );
    }
    return x;
  };
  return fnv1a64(JSON.stringify(walk(schema)));
}

test('SCHEMA_VERSION is bumped whenever a wire schema changes', () => {
  // A failure here means the schemas and the version disagree: bump SCHEMA_VERSION and record
  // the new fingerprint under it, or put the schema back.
  expect({ version: SCHEMA_VERSION, fingerprint: fingerprint(WIRE_SCHEMAS) }).toEqual({
    version: Math.max(...Object.keys(FINGERPRINTS).map(Number)),
    fingerprint: FINGERPRINTS[SCHEMA_VERSION],
  });
});

test('every recorded version has its own fingerprint', () => {
  const values = Object.values(FINGERPRINTS);
  expect(new Set(values).size).toBe(values.length);
});

test('the fingerprint moves with a bound, an option, a key and a check’s logic', () => {
  const shapes = [
    v.strictObject({ a: v.pipe(v.number(), v.maxValue(5)) }),
    v.strictObject({ a: v.pipe(v.number(), v.maxValue(6)) }),
    v.strictObject({ a: v.pipe(v.number(), v.maxValue(5)), b: v.optional(v.string()) }),
    v.strictObject({ a: v.picklist(['x']) }),
    v.strictObject({ a: v.picklist(['x', 'y']) }),
    v.pipe(
      v.strictObject({ a: v.number() }),
      v.check((d) => d.a > 0),
    ),
    v.pipe(
      v.strictObject({ a: v.number() }),
      v.check((d) => d.a >= 0),
    ),
  ];
  const prints = shapes.map(fingerprint);
  expect(new Set(prints).size).toBe(shapes.length);
  // A change to a protocol schema alone moves the wire fingerprint.
  const base = fingerprint(WIRE_SCHEMAS);
  const PullResponse = v.strictObject({
    ...WIRE_SCHEMAS.PullResponse.entries,
    watermarks: v.optional(v.array(v.string())),
  });
  expect(fingerprint({ ...WIRE_SCHEMAS, PullResponse })).not.toBe(base);
  // Rebuilt from the same source, a shape keeps its fingerprint.
  expect(fingerprint(v.strictObject({ a: v.pipe(v.number(), v.maxValue(5)) }))).toBe(prints[0]);
});

/** 64-bit FNV-1a over UTF-16 code units, as hex. The schema package has no Node types. */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
