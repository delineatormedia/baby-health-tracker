import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { serveWeb } from './web.ts';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';
const db = openDatabase(process.env.DATABASE_PATH ?? 'bht.db');
const webRoot = process.env.BHT_WEB_ROOT;

// Passkeys are bound to the relying party: the host name phones open (BHT_RP_ID) and the
// exact origin (BHT_ORIGIN, scheme and port included). Without both, sign-in is off and sync
// answers 401.
const rpId = process.env.BHT_RP_ID;
const origin = process.env.BHT_ORIGIN;
// BHT_REGISTRATION=first allows only the first household; everyone else joins by invite.
const registration = process.env.BHT_REGISTRATION ?? 'open';
if (registration !== 'open' && registration !== 'first') {
  throw new Error(`BHT_REGISTRATION must be open or first, not ${registration}`);
}
// Narrowed for the object literal below.
const mode: 'open' | 'first' = registration;
const auth = rpId && origin ? { rpId, origin, registration: mode } : undefined;
if (!auth) console.warn('BHT_RP_ID and BHT_ORIGIN are not set: sign-in and sync are off');

const app = createApp(db, auth ? { auth } : {});
if (webRoot) serveWeb(app, webRoot);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`bht-server listening on http://${info.address}:${info.port}`);
  if (webRoot) console.log(`serving the web bundle from ${webRoot}`);
});
