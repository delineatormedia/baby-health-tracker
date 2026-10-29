import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { serveWeb } from './web.ts';

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'bht-web-'));
  const root = join(base, 'web');
  mkdirSync(join(root, '_app/immutable/entry'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>bht</title>');
  writeFileSync(join(root, 'service-worker.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(root, 'manifest.webmanifest'), '{}');
  writeFileSync(join(root, '_app/immutable/entry/app.abc123.js'), 'export {};');
  writeFileSync(join(base, 'bht-secret.txt'), 'outside the web root');

  app = createApp(openDatabase(':memory:'));
  serveWeb(app, root);
});

describe('serveWeb', () => {
  test('the API still answers, ahead of the static files', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test('unknown API paths are a JSON 404, never index.html', async () => {
    for (const method of ['GET', 'POST']) {
      const res = await app.request('/api/nope', { method });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/json/);
    }
  });

  test('/ serves index.html and must be revalidated', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>bht</title>');
  });

  test('client routes fall back to index.html', async () => {
    for (const path of ['/settings', '/history/01JABC', '/readings/']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('<title>bht</title>');
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  test('the service worker and manifest must be revalidated', async () => {
    const sw = await app.request('/service-worker.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toMatch(/javascript/);
    expect(sw.headers.get('cache-control')).toBe('no-cache');

    const manifest = await app.request('/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
  });

  test('hashed build output is cached as immutable', async () => {
    const res = await app.request('/_app/immutable/entry/app.abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  test('a missing file with an extension is a 404, not index.html', async () => {
    for (const path of ['/_app/immutable/entry/gone.js', '/favicon.ico']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
  });

  test('paths cannot escape the web root', async () => {
    for (const path of ['/../bht-secret.txt', '/%2e%2e/bht-secret.txt', '/..%2fbht-secret.txt']) {
      const res = await app.request(path);
      expect(await res.text(), path).not.toContain('outside the web root');
    }
  });
});
