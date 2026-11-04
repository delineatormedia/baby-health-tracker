import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const manifest = JSON.parse(
  readFileSync(new URL('../../static/manifest.webmanifest', import.meta.url), 'utf8'),
) as {
  display: string;
  start_url: string;
  scope: string;
  name: string;
  short_name: string;
  id?: string;
  icons: { sizes: string }[];
};

test('manifest is installable', () => {
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons.map((i) => i.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );
});

test('manifest name is SMT/Baby and the install identity does not move (#90)', () => {
  // The owner picked SMT/Baby (2026-11-04). An already installed app keeps its app and
  // data only while its identity holds: this manifest has no id, so the browser keys the
  // installed app on start_url and scope. Those must never move, even as the name does.
  expect(manifest.name).toBe('SMT/Baby');
  expect(manifest.short_name).toBe('SMT/Baby');
  expect(manifest.id).toBeUndefined();
  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');
});
