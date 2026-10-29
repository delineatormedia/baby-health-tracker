import {
  MAX_PULL_LIMIT,
  MAX_PUSH_BATCH,
  MAX_PUSH_BYTES,
  isPushRequestBody,
  SCHEMA_VERSION,
} from '@bht/schema';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { DatabaseSync } from 'node:sqlite';
import {
  Accounts,
  SESSION_COOKIE,
  SESSION_DAYS,
  type AuthConfig,
  type Result,
  type Session,
} from './auth.ts';
import { pullVersions, pushVersions } from './events.ts';

export type { Session } from './auth.ts';

export interface AppOptions {
  /** Passkey relying party. Without it there is no sign-in, and sync answers 401. */
  auth?: AuthConfig;
  /**
   * Resolves the caller's session, or null when signed out. Defaults to the session cookie
   * issued by a passkey sign-in; tests may inject one instead.
   */
  session?: (c: Context) => Session | null | Promise<Session | null>;
  now?: () => Date;
}

type Env = { Variables: { session: Session } };

const AUTH_BODY_BYTES = 64 * 1024;

export function createApp(db: DatabaseSync, opts: AppOptions = {}): Hono<Env> {
  const now = opts.now ?? (() => new Date());
  const accounts = opts.auth ? new Accounts(db, opts.auth, now) : null;
  const resolveSession =
    opts.session ?? ((c: Context) => accounts?.session(getCookie(c, SESSION_COOKIE)) ?? null);
  const app = new Hono<Env>();

  app.get('/api/health', (c) => {
    const row = db.prepare('SELECT sqlite_version() AS sqlite').get() as { sqlite: string };
    return c.json({ ok: true, schemaVersion: SCHEMA_VERSION, sqlite: row.sqlite });
  });

  // Every signed-in route is scoped to the caller's household; there is no unscoped query.
  const signedIn = async (c: Context<Env>, next: () => Promise<void>) => {
    const session = await resolveSession(c);
    if (!session) return c.json({ error: 'Sign in' }, 401);
    c.set('session', session);
    await next();
  };
  app.use('/api/sync', signedIn);
  app.use('/api/household', signedIn);
  app.use('/api/invites', signedIn);
  app.use('/api/babies', signedIn);

  // Passkey ceremonies. Each */options call starts a single-use flow; */verify finishes it
  // and sets an HttpOnly, SameSite=Strict session cookie.
  const authBody = bodyLimit({
    maxSize: AUTH_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request too large' }, 413),
  });
  const json = (c: Context) => c.req.json().catch(() => null) as Promise<unknown>;
  const ceremony = (path: string, run: (a: Accounts, body: unknown) => Promise<Result<object>>) =>
    app.post(path, authBody, async (c) => {
      if (!accounts) return c.json({ error: 'Sign-in is not configured' }, 503);
      const result = await run(accounts, await json(c));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const { token, ...value } = result.value as { token?: string };
      if (token) {
        setCookie(c, SESSION_COOKIE, token, {
          httpOnly: true,
          secure: opts.auth?.secureCookie ?? true,
          sameSite: 'Strict',
          path: '/',
          maxAge: SESSION_DAYS * 86_400,
        });
      }
      return c.json(value);
    });
  ceremony('/api/auth/register/options', (a, b) => a.registerOptions(b));
  ceremony('/api/auth/register/verify', (a, b) => a.registerVerify(b, 'register'));
  ceremony('/api/auth/join/options', (a, b) => a.joinOptions(b));
  ceremony('/api/auth/join/verify', (a, b) => a.registerVerify(b, 'join'));
  ceremony('/api/auth/login/options', (a, b) => a.loginOptions(b));
  ceremony('/api/auth/login/verify', (a, b) => a.loginVerify(b));

  app.post('/api/auth/logout', (c) => {
    accounts?.signOut(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: opts.auth?.secureCookie ?? true });
    return c.json({ ok: true });
  });

  app.get('/api/household', (c) => {
    if (!accounts) return c.json({ error: 'Sign-in is not configured' }, 503);
    return c.json(accounts.household(c.var.session.householdId));
  });

  app.post('/api/babies', authBody, async (c) => {
    if (!accounts) return c.json({ error: 'Sign-in is not configured' }, 503);
    const result = accounts.addBaby(c.var.session.householdId, await json(c));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result.value);
  });

  app.post('/api/invites', (c) => {
    const { householdId, memberId, deviceId } = c.var.session;
    if (!accounts || !memberId || !deviceId) return c.json({ error: 'Sign in' }, 401);
    return c.json(accounts.createInvite({ householdId, memberId, deviceId }));
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
      const results = pushVersions(db, c.var.session, body.events, now());
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
