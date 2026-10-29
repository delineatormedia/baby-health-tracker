import {
  MAX_PULL_LIMIT,
  MAX_PUSH_BATCH,
  MAX_PUSH_BYTES,
  isPushRequestBody,
  SCHEMA_VERSION,
} from '@bht/schema';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DatabaseSync } from 'node:sqlite';
import { pullVersions, pushVersions } from './events.ts';

/** Who is calling: the household every query is scoped to. */
export interface Session {
  householdId: string;
}

export interface AppOptions {
  /**
   * Resolves the caller's session, or null when signed out. Passkey sessions arrive in #5
   * step 2; until then nothing resolves in production, so sync answers 401.
   */
  session?: (c: Context) => Session | null | Promise<Session | null>;
  now?: () => Date;
}

type Env = { Variables: { session: Session } };

export function createApp(db: DatabaseSync, opts: AppOptions = {}): Hono<Env> {
  const resolveSession = opts.session ?? (() => null);
  const now = opts.now ?? (() => new Date());
  const app = new Hono<Env>();

  app.get('/api/health', (c) => {
    const row = db.prepare('SELECT sqlite_version() AS sqlite').get() as { sqlite: string };
    return c.json({ ok: true, schemaVersion: SCHEMA_VERSION, sqlite: row.sqlite });
  });

  // Every sync route is scoped to the caller's household; there is no unscoped query.
  app.use('/api/sync', async (c, next) => {
    const session = await resolveSession(c);
    if (!session) return c.json({ error: 'Sign in' }, 401);
    c.set('session', session);
    await next();
  });

  app.post(
    '/api/sync',
    bodyLimit({
      maxSize: MAX_PUSH_BYTES,
      onError: (c) => c.json({ error: 'Push too large' }, 413),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      // A newer client may write fields, or send a body, this server's schema would reject.
      // Store nothing and let the client keep everything pending until the server is upgraded.
      if (
        Number.isSafeInteger(raw.schemaVersion) &&
        (raw.schemaVersion as number) > SCHEMA_VERSION
      ) {
        return c.json({ error: 'Server schema is older than the app', upgrade: true }, 409);
      }
      if (Array.isArray(raw.events) && raw.events.length > MAX_PUSH_BATCH) {
        return c.json({ error: `At most ${MAX_PUSH_BATCH} versions per push` }, 413);
      }
      if (!isPushRequestBody(body)) {
        return c.json({ error: 'Expected { schemaVersion, events }' }, 400);
      }
      const results = pushVersions(db, c.var.session.householdId, body.events, now());
      return c.json({ results });
    },
  );

  app.get('/api/sync', (c) => {
    const after = intParam(c.req.query('after'), 0);
    const limit = intParam(c.req.query('limit'), MAX_PULL_LIMIT);
    const through = intParam(c.req.query('through'), -1);
    if (after === null || limit === null || limit < 1 || through === null) {
      return c.json({ error: 'Expected after >= 0, limit >= 1 and through >= 0' }, 400);
    }
    return c.json(
      pullVersions(db, c.var.session.householdId, {
        after,
        limit: Math.min(limit, MAX_PULL_LIMIT),
        through: through < 0 ? null : through,
      }),
    );
  });

  return app;
}

/** A query integer, the fallback when absent, or null when present but not an integer. */
function intParam(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
