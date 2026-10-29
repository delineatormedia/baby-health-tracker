import { expect, test } from 'vitest';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';

test('GET /api/health reports ok with the SQLite version', async () => {
  const app = createApp(openDatabase(':memory:'));
  const res = await app.request('/api/health');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; sqlite: string };
  expect(body.ok).toBe(true);
  expect(body.sqlite).toMatch(/^3\./);
});
