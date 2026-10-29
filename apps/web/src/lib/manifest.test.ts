import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const manifest = JSON.parse(
  readFileSync(new URL('../../static/manifest.webmanifest', import.meta.url), 'utf8'),
) as { display: string; start_url: string; icons: { sizes: string }[] };

test('manifest is installable', () => {
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons.map((i) => i.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );
});
