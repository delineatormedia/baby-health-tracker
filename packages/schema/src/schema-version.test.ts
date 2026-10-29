import ts from 'typescript';
import * as v from 'valibot';
import { expect, test } from 'vitest';
import accountSource from './account.ts?raw';
import eventsSource from './events.ts?raw';
import { SCHEMA_VERSION, WIRE_SCHEMAS } from './index.ts';
import modelSource from './model.ts?raw';
import protocolSource from './protocol.ts?raw';

/**
 * Fingerprint of every wire schema (BabyEvent and the /api/sync protocol) per SCHEMA_VERSION,
 * append-only. When a schema changes, bump SCHEMA_VERSION and add a line here; never edit an
 * existing line. Version 1 predates this test (it covered the event types before #19, #22,
 * #24 and #29 added fields, and had no shared protocol).
 */
const FINGERPRINTS: Record<number, string> = {
  2: 'c3e18a1b2cbd3378',
  3: '60b2c7e386696b9f',
};

/**
 * Every module WIRE_SCHEMAS is built from. A check's source text names the helpers and
 * constants it uses but not their bodies or values, so the modules' code is hashed too.
 */
const SCHEMA_MODULES: Record<string, string> = {
  './account.ts': accountSource,
  './events.ts': eventsSource,
  './model.ts': modelSource,
  './protocol.ts': protocolSource,
};

/**
 * What SCHEMA_VERSION covers: the schema tree, plus the code of every module that builds it,
 * so a validation helper (segmentsSide, pumpAgrees) or a constant moves it as well.
 */
function wireFingerprint(modules: Record<string, string> = SCHEMA_MODULES): string {
  return fnv1a64(`${fingerprint(WIRE_SCHEMAS)}\n${codeOf(modules)}`);
}

/**
 * The modules' code as JavaScript: types and comments dropped, runs of whitespace as one
 * space. A comment or type-only edit leaves it alone; any change to what runs moves it.
 */
function codeOf(modules: Record<string, string>): string {
  return Object.entries(modules)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, source]) => {
      const js = ts.transpileModule(source, {
        compilerOptions: {
          removeComments: true,
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText;
      return `${name}\n${js.replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n');
}

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
  expect({ version: SCHEMA_VERSION, fingerprint: wireFingerprint() }).toEqual({
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
  // A change to a protocol schema alone moves the tree fingerprint.
  const base = fingerprint(WIRE_SCHEMAS);
  const PullResponse = v.strictObject({
    ...WIRE_SCHEMAS.PullResponse.entries,
    watermarks: v.optional(v.array(v.string())),
  });
  expect(fingerprint({ ...WIRE_SCHEMAS, PullResponse })).not.toBe(base);
  // Rebuilt from the same source, a shape keeps its fingerprint.
  expect(fingerprint(v.strictObject({ a: v.pipe(v.number(), v.maxValue(5)) }))).toBe(prints[0]);
});

test('SCHEMA_MODULES lists every module the wire schemas import', () => {
  for (const source of Object.values(SCHEMA_MODULES)) {
    for (const [, path] of source.matchAll(/^import (?!type )[^;]*?from '(\.[^']+)'/gm)) {
      expect(Object.keys(SCHEMA_MODULES)).toContain(path);
    }
  }
});

test('the fingerprint moves with a validation helper alone, not with comments or types', () => {
  const base = wireFingerprint();
  const edit = (from: string, to: string) => {
    const source = SCHEMA_MODULES['./events.ts']!;
    expect(source).toContain(from);
    return wireFingerprint({ ...SCHEMA_MODULES, './events.ts': source.replace(from, to) });
  };
  // #46 review: segmentsSide always answering 'both' makes a left-only feed invalid, yet the
  // schema tree only holds segmentsAgree's source, which calls segmentsSide by name.
  expect(
    edit("return sides.size > 1 ? 'both' : (segments[0]?.side ?? 'both');", "return 'both';"),
  ).not.toBe(base);
  // A constant a check reads only by name.
  expect(
    edit('const MAX_FEED_SECONDS = 4 * 60 * 60;', 'const MAX_FEED_SECONDS = 5 * 60 * 60;'),
  ).not.toBe(base);
  // Comments, layout and types do not change what is accepted.
  expect(
    edit("/** The side a feed's segments add up to", '/** Which side the segments add up to'),
  ).toBe(base);
  expect(edit('segments: readonly FeedSegment[]', 'segments:  FeedSegment[]')).toBe(base);
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
