import { SCHEMA_VERSION } from '@bht/schema';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';

export function createApp(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => {
    const row = db.prepare('SELECT sqlite_version() AS sqlite').get() as { sqlite: string };
    return c.json({ ok: true, schemaVersion: SCHEMA_VERSION, sqlite: row.sqlite });
  });

  return app;
}
