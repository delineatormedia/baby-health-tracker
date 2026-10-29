import { serve } from '@hono/node-server';
import { newId, type CeremonyOptions, type HouseholdView } from '@bht/schema';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { SESSION_COOKIE } from './auth.ts';
import { openDatabase } from './db.ts';
import { register } from './testing/phone.ts';

// Login CSRF in a real browser (#47 review): the cookie rules that matter here (SameSite,
// Secure on loopback, Path, what a cross-site form may send) are Chrome's, not Hono's.
// Uses an installed Chrome or Chromium; BHT_CHROME overrides. CI must have one.
const CHROME = [
  process.env.BHT_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!CHROME && process.env.CI) throw new Error('No Chrome for the browser test; set BHT_CHROME');

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

describe.skipIf(!CHROME)('sign-in in a real browser', () => {
  let browser: Browser;
  let target: Server;
  let hostile: Server;
  let origin: string;
  let app: ReturnType<typeof createApp>;
  let hostilePage = '';

  beforeAll(async () => {
    let fetch: ReturnType<typeof createApp>['fetch'] = () => new Response(null, { status: 503 });
    target = serve({ fetch: (req) => fetch(req), hostname: '127.0.0.1', port: 0 }) as Server;
    await new Promise<void>((resolve) => target.on('listening', resolve));
    origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    // Secure cookies as in production: Chrome keeps them on loopback over plain HTTP.
    app = createApp(openDatabase(':memory:'), { auth: { rpId: '127.0.0.1', origin } });
    fetch = app.fetch;
    // localhost and 127.0.0.1 are different sites.
    hostile = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(hostilePage);
    });
    await listen(hostile);
    browser = await chromium.launch({ executablePath: CHROME!, headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    target?.close();
    hostile?.close();
  });

  /** An attacker's own account, and a fresh login assertion for it made outside any browser. */
  async function attackerAssertion() {
    const attacker = await register(app, origin);
    const login = await attacker.phone.ceremony('login', { deviceId: newId() });
    return { attacker, login };
  }

  test('a cross-site text/plain form does not install a session', async () => {
    const { login } = await attackerAssertion();
    // The review's form: padding absorbs the name=value separator, so the body parses as JSON.
    const payload = JSON.stringify({
      flowId: login.flowId,
      response: { ...login.response, padding: '=' },
    });
    const split = payload.indexOf('=');
    const esc = (s: string) =>
      s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    hostilePage =
      `<form method="post" enctype="text/plain" action="${origin}/api/auth/login/verify">` +
      `<input name="${esc(payload.slice(0, split))}" value="${esc(payload.slice(split + 1))}">` +
      `</form><script>document.forms[0].submit()</script>`;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const landed = page.waitForResponse(`${origin}/api/auth/login/verify`);
      await page.goto(`http://localhost:${(hostile.address() as AddressInfo).port}/`);
      expect((await landed).status()).toBe(403);
      expect((await context.cookies()).map((c) => c.name)).not.toContain(SESSION_COOKIE);
      const res = await page.goto(`${origin}/api/household`);
      expect(res!.status()).toBe(401);
    } finally {
      await context.close();
    }
  }, 30_000);

  test('an assertion from another browser, sent with the right headers, does not sign in', async () => {
    const { login } = await attackerAssertion();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/api/health`);
      const status = await page.evaluate(
        async (body) =>
          (
            await fetch('/api/auth/login/verify', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
            })
          ).status,
        JSON.stringify({ flowId: login.flowId, response: login.response }),
      );
      expect(status).toBe(403);
      expect((await context.cookies()).map((c) => c.name)).not.toContain(SESSION_COOKIE);
    } finally {
      await context.close();
    }
  }, 30_000);

  test('the browser that asked for options signs in, and stays signed in', async () => {
    // The control: the same server and cookies, a ceremony started and finished in one browser.
    const { attacker } = await attackerAssertion();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/api/health`);
      const post = (path: string, body: unknown) =>
        page.evaluate(
          async ([path, body]) => {
            const res = await fetch(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
            });
            return { status: res.status, body: await res.json() };
          },
          [path, JSON.stringify(body)] as const,
        );
      const started = await post('/api/auth/login/options', { deviceId: newId() });
      expect(started.status).toBe(200);
      const { flowId, options } = started.body as CeremonyOptions;
      const response = attacker.phone.passkeys.get(
        options as unknown as PublicKeyCredentialRequestOptionsJSON,
      );
      expect((await post('/api/auth/login/verify', { flowId, response })).status).toBe(200);
      const cookies = await context.cookies();
      expect(cookies.find((c) => c.name === SESSION_COOKIE)).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      });
      const res = await page.goto(`${origin}/api/household`);
      expect(res!.status()).toBe(200);
      expect(((await res!.json()) as HouseholdView).id).toBe(attacker.home.householdId);
    } finally {
      await context.close();
    }
  }, 30_000);
});
