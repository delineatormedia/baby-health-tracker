import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';
const db = openDatabase(process.env.DATABASE_PATH ?? 'bht.db');

serve({ fetch: createApp(db).fetch, port, hostname }, (info) => {
  console.log(`bht-server listening on http://${info.address}:${info.port}`);
});
