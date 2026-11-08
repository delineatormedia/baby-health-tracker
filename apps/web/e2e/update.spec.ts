import { expect, test, type Page } from '@playwright/test';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { current, phone, until, watchErrors } from './helpers.ts';

// A new build reaches the screen within one screen change or reopen, and never mid-entry (#70).
// Build N is this worktree's build. Builds N+1 and N+2 are copies under new versions, so their
// service worker scripts and cache names differ, with a marker in their shells. Every hashed file
// is renamed in each copy, as a real deploy renames them, so N's files exist only in N's cache.
// Each test serves N on its own origin, then switches the same origin to a newer build, the way a
// server update does. Every case runs under production's immutable asset headers and under no-cache.

const BUILD = join(import.meta.dirname, '..', 'build');
const MARK = '<meta name="bht-build" content="next" />';
// apps/server/src/web.ts
const IMMUTABLE = 'public, max-age=31536000, immutable';

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  );

/** A copy of build N under version N+`n`, with every hashed file renamed. */
function newer(n: number): string {
  const version = JSON.parse(readFileSync(join(BUILD, '_app/version.json'), 'utf8')).version;
  const dir = mkdtempSync(join(tmpdir(), `bht-next${n}-`));
  cpSync(BUILD, dir, { recursive: true });
  const hashed = walk(join(dir, '_app/immutable'));
  const renamed = new Map(
    hashed.map((f) => [basename(f), basename(f).replace(/(\.[a-z]+)$/, `n${n}$1`)]),
  );
  for (const f of hashed) renameSync(f, join(dirname(f), renamed.get(basename(f))!));
  const names = new RegExp(
    [...renamed.keys()].map((k) => k.replace(/[.$]/g, '\\$&')).join('|'),
    'g',
  );
  let swapped = 0;
  for (const f of walk(dir).filter((f) => /\.(html|js|json|css)$/.test(f))) {
    const text = readFileSync(f, 'utf8');
    let out = text.replaceAll(version, `${version}${n}`).replace(names, (k) => renamed.get(k)!);
    if (f === join(dir, 'index.html')) out = out.replace('</head>', `${MARK}</head>`);
    if (out !== text) {
      writeFileSync(f, out);
      swapped++;
    }
  }
  // The worker, the shell, version.json and the route files at least; otherwise not a new build.
  expect(swapped).toBeGreaterThanOrEqual(
    3 + readdirSync(join(BUILD, '_app/immutable/nodes')).length,
  );
  const worker = join(dir, 'service-worker.js');
  writeFileSync(worker, readFileSync(worker, 'utf8') + diagnostics(n));
  return dir;
}

/**
 * Lines added to a copy's worker, never the product one (#92): it reports when it is evaluated,
 * installs, finishes or fails its `addAll`, skips waiting and activates, to the test server's
 * `/__diag` route. A swap that never comes then says which of those the new worker reached.
 *
 * Every report is fire-and-forget: nothing here is awaited and nothing goes through `waitUntil`,
 * so a slow or lost report can never lengthen the lifecycle it watches. The price is that a
 * missing report means only that none arrived, never that the worker did not get there.
 */
const diagnostics = (n: number) => `
// e2e only (#92): this copy reports its install to the test server, never waiting on it.
{
  const say = (what) => {
    try {
      fetch('/__diag/n${n}:' + what, { cache: 'no-store' }).catch(() => {});
    } catch {
      // Reporting is best effort.
    }
  };
  const addAll = Cache.prototype.addAll;
  Cache.prototype.addAll = function (urls) {
    return addAll.call(this, urls).then(
      (r) => (say('addAll-ok'), r),
      (e) => {
        say('addAll-failed:' + encodeURIComponent(String((e && e.message) || e)));
        throw e;
      },
    );
  };
  const skip = self.skipWaiting.bind(self);
  self.skipWaiting = () => (say('skipWaiting'), skip());
  self.addEventListener('install', () => say('install'));
  self.addEventListener('activate', () => say('activate'));
  say('evaluated');
}
`;

/** The stages a copy's worker reports on a healthy swap, as they appear in `Served.diag`. */
const STAGES = ['evaluated', 'install', 'addAll-ok', 'skipWaiting', 'activate'];

/**
 * Waits, bounded, for copy N+`n`'s worker to have reported every stage. Reports are not awaited
 * by the worker, so they can land after the swap; a shortfall here is a telemetry failure (the
 * report did not arrive), which is all it can mean.
 */
const reported = (s: Served, n: number) =>
  expect
    .poll(
      () =>
        s.diag
          .map((l) => l.slice(l.indexOf(' ') + 1))
          .filter((l) => l.startsWith(`worker n${n}:`))
          .sort(),
      { timeout: 5_000 },
    )
    .toEqual(STAGES.map((e) => `worker n${n}:${e}`).sort());

let next: string;
let next2: string;

test.beforeAll(() => {
  next = newer(1);
  next2 = newer(2);
});

test.afterAll(() => {
  rmSync(next, { recursive: true, force: true });
  rmSync(next2, { recursive: true, force: true });
});

type Headers = 'immutable' | 'no-cache';

/**
 * A served build: `diag` holds what the newer copies' workers reported, timestamped, as each
 * report arrives (#92). `hold(report)` keeps the replies to one report back until the returned
 * function is called, the way a slow network would.
 */
interface Served {
  url: string;
  switchTo: (dir: string) => void;
  server: Server;
  diag: string[];
  hold: (report: string) => () => void;
}

/**
 * Serves a build the way the family server does: files, else the SPA shell; no API. A missing
 * file with an extension is a 404, so a page asking for an old build's file gets nothing.
 */
async function serve(headers: Headers): Promise<Served> {
  let root = BUILD;
  const diag: string[] = [];
  const held = new Map<string, (() => void)[]>();
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (path.startsWith('/__diag/')) {
      const report = path.slice('/__diag/'.length);
      diag.push(`${Date.now()} worker ${report}`);
      const reply = () => res.writeHead(204).end();
      if (held.has(report)) held.get(report)!.push(reply);
      else reply();
      return;
    }
    if (path.startsWith('/api')) {
      res.writeHead(404).end();
      return;
    }
    const file = normalize(join(root, path));
    let body: Buffer;
    let type = TYPES[extname(file)] ?? 'application/octet-stream';
    try {
      if (!file.startsWith(root) || path.endsWith('/')) throw new Error('shell');
      body = readFileSync(file);
    } catch {
      if (path.slice(path.lastIndexOf('/') + 1).includes('.')) {
        res.writeHead(404).end();
        return;
      }
      body = readFileSync(join(root, 'index.html'));
      type = TYPES['.html']!;
    }
    const cache =
      headers === 'immutable' && path.startsWith('/_app/immutable/') ? IMMUTABLE : 'no-cache';
    res.writeHead(200, { 'content-type': type, 'cache-control': cache }).end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  const hold = (report: string) => {
    held.set(report, []);
    return () => {
      for (const reply of held.get(report) ?? []) reply();
      held.delete(report);
    };
  };
  return { url: `http://127.0.0.1:${port}`, switchTo: (dir) => (root = dir), server, diag, hold };
}

/** What the page saw of the worker swap (#92): `swlog` lines are `<Date.now()> page <event>`. */
interface Watched {
  loadN: boolean;
  tookOver: boolean;
  swlog: string[];
}

/**
 * Waits until build N's worker controls the page, and marks this page load. From here the page
 * also keeps a log of the swap (#92): each `registration.update()` the app makes and how it
 * settled, `updatefound`, the new worker's states, and `controllerchange`.
 */
async function installed(page: Page) {
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 15_000,
    })
    .toBe(true);
  await activated(page);
  await page.evaluate(() => {
    const w = window as unknown as Watched;
    w.loadN = true;
    w.swlog = [];
    const log = (event: string) => w.swlog.push(`${Date.now()} page ${event}`);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      w.tookOver = true;
      log('controllerchange');
    });
    const update = ServiceWorkerRegistration.prototype.update;
    ServiceWorkerRegistration.prototype.update = function (this: ServiceWorkerRegistration) {
      log('update() called');
      return update.call(this).then(
        (r) => (log('update() resolved'), r),
        (e: unknown) => {
          log(`update() rejected: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        },
      );
    };
    void navigator.serviceWorker.getRegistration().then((r) => {
      r?.addEventListener('updatefound', () => {
        const fresh = r.installing;
        log(`updatefound, installing ${fresh?.state ?? 'null'}`);
        fresh?.addEventListener('statechange', () => log(`new worker ${fresh.state}`));
      });
    });
  });
}

/** Switches the server to a newer build (N+1 by default) and resumes the app, which asks for a new worker. */
async function update(page: Page, s: Served, to = next) {
  await page.evaluate(() => ((window as unknown as Watched).tookOver = false));
  s.switchTo(to);
  const resumed = Date.now();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  try {
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Watched).tookOver), {
        timeout: 15_000,
      })
      .toBe(true);
    await activated(page);
  } catch (e) {
    // Only a swap that never came, or never finished activating, pays for this (#92): the page's
    // and the worker's logs, so the failure names the stage the new worker reached, and the
    // registration's end state.
    const timeline = await swapTimeline(page, s, resumed);
    await test.info().attach('worker-swap-timeline', { body: timeline, contentType: 'text/plain' });
    throw new Error(
      `${(e as Error).message}\n\nWorker swap timeline (ms after the resume):\n${timeline}`,
      { cause: e },
    );
  }
}

/** Both sides' logs merged in time order, relative to `since`, then the registration's state. */
async function swapTimeline(page: Page, s: Served, since: number): Promise<string> {
  const swlog = await page.evaluate(() => (window as unknown as Watched).swlog ?? []);
  const lines = [...swlog, ...s.diag]
    .map((l) => {
      const at = Number(l.slice(0, l.indexOf(' ')));
      return { at, text: `${String(at - since).padStart(6)} ${l.slice(l.indexOf(' ') + 1)}` };
    })
    .sort((a, b) => a.at - b.at)
    .map((l) => l.text);
  const state = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    const worker = (w: ServiceWorker | null) => w?.state ?? 'null';
    return r
      ? `installing ${worker(r.installing)}, waiting ${worker(r.waiting)}, active ${worker(r.active)}, controller ${worker(navigator.serviceWorker.controller)}`
      : 'no registration';
  });
  return [...lines, `registration now: ${state}`].join('\n');
}

// controllerchange fires as the new worker starts activating, before its activate handler has
// trimmed old caches; checking a page before then sees caches the worker is about to delete.
async function activated(page: Page) {
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state), {
      timeout: 15_000,
    })
    .toBe('activated');
}

/** Still the page build N loaded: no reload has happened. */
const samePage = (page: Page) =>
  page.evaluate(() => (window as unknown as { loadN?: boolean }).loadN === true);
const onNext = (page: Page) => expect(page.locator('meta[name="bht-build"]')).toHaveCount(1);

// A write in flight is never lost to an update reload (#74). Storage contention is a readwrite
// transaction held open on another connection, so the app's own write queues behind it.

/** Holds `versions` until `release`; resolves once a write of the app's has queued behind it. */
async function hold(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((ok) => {
        const w = window as unknown as { release?: boolean };
        w.release = false;
        const q = indexedDB.open('bht');
        q.onsuccess = () => {
          const store = q.result.transaction('versions', 'readwrite').objectStore('versions');
          const keep = () => {
            if (w.release) q.result.close();
            else store.get('held').onsuccess = keep;
          };
          keep();
          ok();
        };
      }),
  );
}

/** Starts counting the app's transactions, to see a write queued behind `hold`. */
const countWrites = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { writes: number };
    w.writes = 0;
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[1] === 'readwrite') w.writes++;
      return original.apply(this, args);
    };
  });
const queued = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => (window as unknown as { writes: number }).writes))
    .toBeGreaterThan(0);
const release = (page: Page) =>
  page.evaluate(() => ((window as unknown as { release: boolean }).release = true));

/** Leaves the app, the way the Home Screen app is put away. */
const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

/** Build N on Home with N+1 installed and in control: the next safe chance reloads. */
async function armed(browser: Parameters<typeof phone>[0], headers: Headers) {
  const s = await serve(headers);
  const ctx = await phone(browser, 390, 'light', { serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(s.url);
  await page.locator('.rail').waitFor();
  await installed(page);
  return { s, ctx, page, errors };
}

/** Nothing is in progress on screen, so only the queued write can hold the reload off. */
async function screenIdle(page: Page) {
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
}

for (const headers of ['immutable', 'no-cache'] as const) {
  test.describe(`${headers} assets`, () => {
    test('a running feed timer stays on screen; the next screen loads the new build', async ({
      browser,
    }) => {
      const s = await serve(headers);
      const ctx = await phone(browser, 390, 'light', { serviceWorkers: 'allow' });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(s.url);
      await page.locator('.rail').waitFor();
      await installed(page);
      await page.getByRole('button', { name: /^Feed/ }).tap();
      await page.getByRole('button', { name: /^Left/ }).tap();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();

      await update(page, s);
      // The timer screen is not reloaded under the parent, with or without the start toast up.
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
      expect(await samePage(page)).toBe(true);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0, {
        timeout: 10_000,
      });
      expect(await samePage(page)).toBe(true);

      // A running timer has no Home button; the parent swipes back.
      await page.goBack();
      await page.waitForURL((u) => u.pathname === '/');
      await onNext(page);
      expect(await samePage(page)).toBe(false);
      const [feed] = await current(page, 'breastfeed');
      expect(feed!.data.durationSeconds).toBeNull();
      await page.getByRole('link', { name: 'Open the breastfeed timer' }).tap();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('a half-entered bottle stays on screen and saves; the next launch is the new build', async ({
      browser,
    }) => {
      const s = await serve(headers);
      const ctx = await phone(browser, 390, 'light', { serviceWorkers: 'allow' });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(`${s.url}/bottle`);
      await installed(page);
      await page.getByRole('button', { name: 'Formula', exact: true }).tap();
      const vessel = page.getByRole('slider').first();
      const box = (await vessel.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const readout = await page.locator('.readout').textContent();
      expect(readout).not.toMatch(/^\s*0 /);

      await update(page, s);
      expect(await samePage(page)).toBe(true);
      await expect(page.locator('.readout')).toHaveText(readout!);
      await expect(page.getByRole('button', { name: 'Formula', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // Saving goes Home with the Undo toast up, so that screen change keeps the old build too.
      await page.locator('button.go').tap();
      await page.waitForURL((u) => u.pathname === '/');
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      expect(await samePage(page)).toBe(true);
      const [bottle] = await until(
        page,
        () => current(page, 'bottle'),
        (b) => b.length === 1,
      );
      expect(bottle!.data.contents).toBe('formula');

      // Reopen: the next launch opens on N+1 with the bottle in the log.
      await page.close();
      const again = await ctx.newPage();
      const errorsAgain = watchErrors(again);
      await again.goto(s.url);
      await again.locator('.rail').waitFor();
      await onNext(again);
      expect((await current(again, 'bottle')).map((b) => b.id)).toEqual([bottle!.id]);
      expect([...errors, ...errorsAgain]).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('leaving the app from Home loads the new build for the next launch', async ({
      browser,
    }) => {
      const s = await serve(headers);
      const ctx = await phone(browser, 390, 'light', { serviceWorkers: 'allow' });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(s.url);
      await page.locator('.rail').waitFor();
      await installed(page);
      await update(page, s);
      expect(await samePage(page)).toBe(true);
      // The copy's worker reports to the test server (#92): checked once here, on a healthy
      // swap, so the reporting itself is known to work when a failure's timeline is read.
      await reported(s, 1);

      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await onNext(page);
      await page.locator('.rail').waitFor();
      expect(await samePage(page)).toBe(false);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('a slow report from the new worker never holds the swap (#92)', async ({ browser }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      // The server sits on the reply to the install report, as a slow network would. The swap
      // watches nothing of ours: it completes in its usual time, and the report lands later.
      const release = s.hold('n1:install');
      await update(page, s);
      expect(await samePage(page)).toBe(true);
      release();
      await reported(s, 1);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('leaving the app while a Wet is queued keeps the page, and the Wet saves', async ({
      browser,
    }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      await update(page, s);
      await countWrites(page);
      await hold(page);
      await page.getByRole('button', { name: /^Wet/ }).tap();
      await queued(page);
      await screenIdle(page);

      await hide(page);
      await page.waitForTimeout(500);
      expect(await samePage(page)).toBe(true);
      await release(page);
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      expect(await samePage(page)).toBe(true);
      expect(await current(page, 'diaper')).toHaveLength(1);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('leaving the app while an Undo is queued keeps the page, and the Undo lands', async ({
      browser,
    }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      await page.getByRole('button', { name: /^Wet/ }).tap();
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      await update(page, s);
      await countWrites(page);
      await hold(page);
      await page.getByRole('button', { name: 'Undo', exact: true }).tap();
      await queued(page);
      // The toast times out while the Undo waits on storage: nothing on screen says busy.
      await screenIdle(page);

      await hide(page);
      await page.waitForTimeout(500);
      expect(await samePage(page)).toBe(true);
      await release(page);
      await expect(page.getByText('Undone')).toBeVisible();
      expect(await samePage(page)).toBe(true);
      expect(await current(page, 'diaper')).toEqual([]);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('leaving the app while an Undo of an edit is queued keeps the page, and it lands', async ({
      browser,
    }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      // A feed started before the update, stopped on Home after it: stopping is an edit.
      await page.getByRole('button', { name: /^Feed/ }).tap();
      await page.getByRole('button', { name: /^Left/ }).tap();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await page.goBack();
      await page.waitForURL((u) => u.pathname === '/');
      await update(page, s);
      await page.getByRole('button', { name: /^Stop the breastfeed/ }).tap();
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      const [stopped] = await current(page, 'breastfeed');
      expect(stopped!.data.durationSeconds).not.toBeNull();
      await countWrites(page);
      await hold(page);
      await page.getByRole('button', { name: 'Undo', exact: true }).tap();
      await queued(page);
      await screenIdle(page);

      await hide(page);
      await page.waitForTimeout(500);
      expect(await samePage(page)).toBe(true);
      await release(page);
      await expect(page.getByText('Undone')).toBeVisible();
      expect(await samePage(page)).toBe(true);
      // Undoing the stop restores the running feed.
      const [feed] = await current(page, 'breastfeed');
      expect(feed!.data.durationSeconds).toBeNull();
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('leaving the app while a Retry is queued keeps the page, and the retry lands', async ({
      browser,
    }) => {
      const { s, ctx, page } = await armed(browser, headers);
      await page.getByRole('button', { name: /^Wet/ }).tap();
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      await update(page, s);
      // The first Undo fails, leaving its inverse behind Retry undo.
      await page.evaluate(() => {
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function () {
          IDBDatabase.prototype.transaction = original;
          throw new DOMException('Full', 'QuotaExceededError');
        };
      });
      await page.getByRole('button', { name: 'Undo', exact: true }).tap();
      const retry = page.getByRole('button', { name: 'Retry undo', exact: true });
      await retry.waitFor();
      await countWrites(page);
      await hold(page);
      await retry.tap();
      await queued(page);
      await screenIdle(page);

      await hide(page);
      await page.waitForTimeout(500);
      expect(await samePage(page)).toBe(true);
      await release(page);
      await expect(page.getByText('Undone')).toBeVisible();
      expect(await samePage(page)).toBe(true);
      expect(await current(page, 'diaper')).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('a tap while a Wet is queued opens its screen in this build, and the Wet saves', async ({
      browser,
    }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      await update(page, s);
      await countWrites(page);
      await hold(page);
      await page.getByRole('button', { name: /^Wet/ }).tap();
      await queued(page);
      await screenIdle(page);

      await page.getByRole('link', { name: 'History', exact: true }).tap();
      await page.waitForURL((u) => u.pathname === '/history');
      expect(await samePage(page)).toBe(true);
      await release(page);
      const diapers = await until(
        page,
        () => current(page, 'diaper'),
        (d) => d.length === 1,
      );
      expect(diapers).toHaveLength(1);
      expect(await samePage(page)).toBe(true);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('a page with a Wet queued through two takeovers opens its screen in its build, and the Wet saves', async ({
      browser,
    }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      await update(page, s);
      await countWrites(page);
      await hold(page);
      await page.getByRole('button', { name: /^Wet/ }).tap();
      await queued(page);
      await screenIdle(page);
      // N+2 takes over while the page still runs N, so N's files must outlast two newer builds.
      await update(page, s, next2);
      expect(await samePage(page)).toBe(true);

      await page.getByRole('link', { name: 'History', exact: true }).tap();
      await page.waitForURL((u) => u.pathname === '/history');
      expect(await samePage(page)).toBe(true);
      await release(page);
      const diapers = await until(
        page,
        () => current(page, 'diaper'),
        (d) => d.length === 1,
      );
      expect(diapers).toHaveLength(1);
      expect(await samePage(page)).toBe(true);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('back or forward while a Wet is queued skips this chance and keeps its toast', async ({
      browser,
    }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      // History to go forward into, made before the update so neither move reloads.
      await page.getByRole('link', { name: 'History', exact: true }).tap();
      await page.waitForURL((u) => u.pathname === '/history');
      await page.goBack();
      await page.waitForURL((u) => u.pathname === '/');
      await update(page, s);
      await countWrites(page);
      await hold(page);
      await page.getByRole('button', { name: /^Wet/ }).tap();
      await queued(page);
      await screenIdle(page);

      await page.goForward();
      await page.waitForURL((u) => u.pathname === '/history');
      await page.waitForTimeout(500);
      expect(await samePage(page)).toBe(true);
      await release(page);
      // The settled Wet raised its Undo toast, so the page stays for the parent to use it.
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      expect(await samePage(page)).toBe(true);
      expect(await current(page, 'diaper')).toHaveLength(1);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('a bottle entered after Back during a quiet edit stays and saves; the next screen updates', async ({
      browser,
    }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      await page.getByRole('button', { name: /^Feed/ }).tap();
      await page.getByRole('button', { name: /^Left/ }).tap();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await screenIdle(page);
      await update(page, s);
      const [feed] = await current(page, 'breastfeed');
      await countWrites(page);
      await hold(page);
      // Moving the start time is an edit with no toast: once it queues, nothing on screen is busy.
      const earlier = await page.evaluate(() => {
        const d = new Date(Date.now() - 5 * 60_000);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      });
      await page.getByLabel('Change the start time').fill(earlier);
      await queued(page);

      await page.goBack();
      await page.waitForURL((u) => u.pathname === '/');
      await page.getByRole('button', { name: /^Bottle/ }).tap();
      await page.waitForURL((u) => u.pathname === '/bottle');
      await page.getByRole('button', { name: 'Formula', exact: true }).tap();
      const vessel = page.getByRole('slider').first();
      const box = (await vessel.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const readout = await page.locator('.readout').textContent();
      expect(readout).not.toMatch(/^\s*0 /);

      await release(page);
      const [moved] = await until(
        page,
        () => current(page, 'breastfeed'),
        ([f]) => f!.occurredAt !== feed!.occurredAt,
      );
      expect(moved!.data.durationSeconds).toBeNull();
      await page.waitForTimeout(500);
      expect(await samePage(page)).toBe(true);
      await expect(page.locator('.readout')).toHaveText(readout!);
      await expect(page.getByRole('button', { name: 'Formula', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      await page.locator('button.go').tap();
      await page.waitForURL((u) => u.pathname === '/');
      const [bottle] = await until(
        page,
        () => current(page, 'bottle'),
        (b) => b.length === 1,
      );
      expect(bottle!.data.contents).toBe('formula');
      expect(await samePage(page)).toBe(true);

      // The update stayed armed: the next clean screen change loads it.
      await screenIdle(page);
      await page.getByRole('link', { name: 'History', exact: true }).tap();
      await page.waitForURL((u) => u.pathname === '/history');
      await onNext(page);
      expect(await samePage(page)).toBe(false);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });

    test('a bottle typed before a same-screen Back keeps its time and choices; the next screen updates', async ({
      browser,
    }) => {
      const { s, ctx, page, errors } = await armed(browser, headers);
      await page.getByRole('button', { name: /^Bottle/ }).tap();
      await page.waitForURL((u) => u.pathname === '/bottle');
      // Test fixture only: the app has no such link. A query navigation adds a history entry
      // while Bottle stays mounted, so Back lands on the screen that holds the typed entry.
      await page.evaluate(() => {
        const a = document.createElement('a');
        a.href = '/bottle?fixture=1';
        a.textContent = 'Fixture query navigation';
        document.body.append(a);
      });
      await page.getByRole('link', { name: 'Fixture query navigation' }).click();
      await page.waitForURL((u) => u.search === '?fixture=1');
      await update(page, s);
      await page.getByRole('button', { name: 'Formula', exact: true }).tap();
      const vessel = page.getByRole('slider').first();
      const box = (await vessel.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const readout = await page.locator('.readout').textContent();
      await page.locator('.trow > button').tap();
      const earlier = await page.evaluate(() => {
        const d = new Date(Date.now() - 60_000);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      });
      await page.getByLabel('Pick a time').fill(earlier);
      const time = await page.locator('.trow .val').textContent();
      expect(time).not.toBe('Now');

      await page.goBack();
      await page.waitForURL((u) => u.pathname === '/bottle' && !u.search);
      await page.waitForTimeout(500);
      expect(await samePage(page)).toBe(true);
      // The "· N min ago" half ticks with the real clock; occurredAt below pins the exact time.
      const clock = time!.split(' · ')[0]!;
      await expect(page.locator('.trow .val')).toContainText(`${clock} · `);
      await expect(page.locator('.readout')).toHaveText(readout!);
      await expect(page.getByRole('button', { name: 'Formula', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      await page.locator('button.go').tap();
      await page.waitForURL((u) => u.pathname === '/');
      const [bottle] = await until(
        page,
        () => current(page, 'bottle'),
        (b) => b.length === 1,
      );
      expect(bottle!.data.contents).toBe('formula');
      expect(bottle!.data.volumeMl).toBe(parseInt(readout!));
      expect(bottle!.occurredAt).toBe(
        await page.evaluate((v) => new Date(v).toISOString(), earlier),
      );

      await screenIdle(page);
      await page.getByRole('link', { name: 'History', exact: true }).tap();
      await page.waitForURL((u) => u.pathname === '/history');
      await onNext(page);
      expect(await samePage(page)).toBe(false);
      expect(errors).toEqual([]);
      await ctx.close();
      s.server.close();
    });
  });
}
