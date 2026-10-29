import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { join } from 'node:path';

// Hashed build output never changes under the same name. Everything else must be
// revalidated, or a phone keeps an old service worker and index.html after a deploy.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

/**
 * Serves the built web bundle from `root` with a single-page-app fallback.
 * Call after the API routes: unknown `/api/*` paths stay 404, and so do missing
 * files with an extension, so the service worker never caches index.html as a script.
 */
export function serveWeb(app: Hono, root: string): void {
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  app.use('*', async (c, next) => {
    await next();
    if (c.res.ok) {
      c.res.headers.set(
        'Cache-Control',
        c.req.path.startsWith('/_app/immutable/') ? IMMUTABLE : REVALIDATE,
      );
    }
  });

  app.use('*', serveStatic({ root }));

  const index = serveStatic({ path: join(root, 'index.html') });
  app.get('*', (c, next) => {
    const last = c.req.path.slice(c.req.path.lastIndexOf('/') + 1);
    return last.includes('.') ? next() : index(c, next);
  });
}
