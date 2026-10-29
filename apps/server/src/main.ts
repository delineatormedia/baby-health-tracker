import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';
const db = openDatabase(process.env.DATABASE_PATH ?? 'bht.db');

// Passkeys are bound to the relying party: the host name phones open (BHT_RP_ID) and the
// exact origin (BHT_ORIGIN, scheme and port included). Without both, sign-in is off and sync
// answers 401.
const rpId = process.env.BHT_RP_ID;
const origin = process.env.BHT_ORIGIN;
const auth = rpId && origin ? { rpId, origin } : undefined;
if (!auth) console.warn('BHT_RP_ID and BHT_ORIGIN are not set: sign-in and sync are off');

serve({ fetch: createApp(db, auth ? { auth } : {}).fetch, port, hostname }, (info) => {
  console.log(`bht-server listening on http://${info.address}:${info.port}`);
});
