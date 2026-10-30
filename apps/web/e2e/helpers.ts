import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const MIN = 60_000;

export interface Seeded {
  type: string;
  /** ISO time or ms. */
  at: string | number;
  data: unknown;
}

export const BABY = {
  id: '01JBQ7Z9X8Y6W5V4T3S2R1Q0PN',
  householdId: '01JBQ7Z9X8Y6W5V4T3S2R1Q0PM',
  name: 'Juniper',
  birthAt: '2026-10-17T14:42:00.000Z',
  sex: 'female',
} as const;

export const STOOL = { color: 'mustard', consistency: 'seedy', size: 'medium', flags: [] };

export type Theme = 'light' | 'night';

/**
 * A phone-sized context: touch, the given width (568 tall at 320, 844 at 390) and theme. The
 * baby and prefs are in localStorage before the app's first script runs.
 */
export async function phone(
  browser: Browser,
  width: 320 | 390,
  theme: Theme = 'light',
  opts: { baby?: boolean; serviceWorkers?: 'allow' } = {},
): Promise<BrowserContext> {
  const c = await browser.newContext({
    ...(opts.serviceWorkers ? { serviceWorkers: opts.serviceWorkers } : {}),
    viewport: { width, height: width === 320 ? 568 : 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    colorScheme: theme === 'night' ? 'dark' : 'light',
  });
  await c.addInitScript(
    ([baby, theme, withBaby]) => {
      if (withBaby && !localStorage.getItem('bht.baby'))
        localStorage.setItem('bht.baby', JSON.stringify(baby));
      if (!localStorage.getItem('bht.prefs'))
        localStorage.setItem('bht.prefs', JSON.stringify({ volume: 'ml', theme, dayStart: 0 }));
    },
    [BABY, theme, opts.baby !== false] as const,
  );
  return c;
}

/** Fails the test on any page error or console error. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Opens a route and waits until the app has rendered it. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('main').first().waitFor();
}

/**
 * Writes events straight into the app's IndexedDB as pending local versions, then reloads so
 * the app reads them. The app must have opened its database once (any page load does).
 */
export async function seed(page: Page, events: Seeded[], path = '/'): Promise<void> {
  await open(page, path);
  await page.evaluate(
    ({ events, babyId }) =>
      new Promise<void>((ok, fail) => {
        const q = indexedDB.open('bht');
        q.onerror = () => fail(q.error);
        q.onsuccess = () => {
          const db = q.result;
          const tx = db.transaction('versions', 'readwrite');
          events.forEach(({ type, at, data }, i) => {
            // Valid ULIDs, sortable in seed order.
            const id = `01JE2E${String(i).padStart(4, '0')}0000000000000000`;
            const iso = new Date(at).toISOString();
            const event = {
              id,
              babyId,
              authorId: '01JE2EA0THER0000000000000Z',
              occurredAt: iso,
              recordedAt: iso,
              version: 1,
              deleted: false,
              notes: null,
              type,
              data,
            };
            tx.objectStore('versions').put({
              key: `${id}:1:local`,
              id,
              babyId,
              seq: null,
              pending: 1,
              event,
            });
          });
          tx.oncomplete = () => {
            db.close();
            ok();
          };
          tx.onerror = () => fail(tx.error);
        };
      }),
    { events, babyId: BABY.id },
  );
  await page.reload();
  await page.locator('main').first().waitFor();
}

export interface StoredEvent {
  id: string;
  type: string;
  version: number;
  deleted: boolean;
  occurredAt: string;
  data: Record<string, unknown> & { [k: string]: unknown };
}

/** Every version held for each event, oldest first, read from IndexedDB. */
export async function versions(page: Page): Promise<Map<string, StoredEvent[]>> {
  const rows = await page.evaluate(
    () =>
      new Promise<StoredEvent[]>((ok, fail) => {
        const q = indexedDB.open('bht');
        q.onerror = () => fail(q.error);
        q.onsuccess = () => {
          const r = q.result.transaction('versions').objectStore('versions').getAll();
          r.onsuccess = () => {
            q.result.close();
            ok((r.result as { event: StoredEvent }[]).map((row) => row.event));
          };
        };
      }),
  );
  const out = new Map<string, StoredEvent[]>();
  for (const e of rows.sort((a, b) => a.version - b.version)) {
    out.set(e.id, [...(out.get(e.id) ?? []), e]);
  }
  return out;
}

/** Current, non-deleted events of a type, newest occurrence first (one phone: highest version wins). */
export async function current(page: Page, type?: string): Promise<StoredEvent[]> {
  return [...(await versions(page)).values()]
    .map((v) => v.at(-1)!)
    .filter((e) => !e.deleted && (type === undefined || e.type === type))
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
}

/** Waits until the store holds what `check` wants, re-reading IndexedDB. */
export async function until<T>(page: Page, read: () => Promise<T>, check: (v: T) => boolean) {
  await expect.poll(async () => check(await read()), { timeout: 5000 }).toBe(true);
  return read();
}

/** Horizontal overflow of the page and the first elements sticking out of the viewport. */
export function overflow(page: Page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth - innerWidth,
    out: [...document.querySelectorAll('main *')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < -0.5 || r.right > innerWidth + 0.5);
      })
      .map((e) => `${e.tagName}.${String(e.className).split(' ')[0]}`)
      .slice(0, 5),
  }));
}

/** Home keys whose label or lines reach past the key's outline (#53: the icon grows with the key). */
export function spill(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('main .key')].flatMap((key) => {
      const k = key.getBoundingClientRect();
      const cs = getComputedStyle(key);
      const right = k.right - parseFloat(cs.borderRightWidth);
      return [...key.querySelectorAll('*')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > right + 0.5;
        })
        .map((e) => `${key.getAttribute('aria-label')}: ${e.tagName} ${e.textContent!.trim()}`);
    }),
  );
}
