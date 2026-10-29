import { expect, test, type Page } from '@playwright/test';
import { BABY, open, phone, watchErrors } from './helpers.ts';

// Two tabs of one signed-in phone share IndexedDB and its pull cursor (#64 review). The sync
// API is answered here; the app under test is the production build.

const T = Date.parse('2026-10-29T12:00:00Z');
const SELF = '01JE2ESE1F0000000000000000';
const SAM = '01JE2ESAM00000000000000000';

/** Six wet diapers from Sam's phone, inside the last completed day (America/New_York). */
const WET = Array.from({ length: 6 }, (_, i) => ({
  seq: i + 1,
  event: {
    id: `01JE2EWET${i}0000000000000000`,
    babyId: BABY.id,
    authorId: SAM,
    version: 1,
    deleted: false,
    notes: null,
    recordedAt: '2026-10-28T13:00:00.000Z',
    occurredAt: '2026-10-28T13:00:00.000Z',
    type: 'diaper',
    data: { kind: 'wet' },
  },
}));

const wetDiapers = (page: Page) =>
  page
    .locator('.list details')
    .filter({ has: page.locator('summary span').filter({ hasText: /^Wet diapers$/ }) })
    .locator('b.num');

test('a tab whose pull comes back empty still shows what another tab pulled', async ({
  browser,
}) => {
  const ctx = await phone(browser, 390);
  await ctx.addInitScript(
    ([household, self, setupAt]) => {
      localStorage.setItem(
        'bht.account',
        JSON.stringify({ householdId: household, memberId: self }),
      );
      localStorage.setItem('bht.author', self);
      localStorage.setItem('bht.setupAt', String(setupAt));
    },
    [BABY.householdId, SELF, Date.parse(BABY.birthAt)] as const,
  );
  // A running clock at T in every tab: page.clock is per page, and the clock sample needs
  // Date and performance.now to move together.
  await ctx.addInitScript((fixed) => {
    const Real = Date;
    const delta = fixed - Real.now();
    globalThis.Date = class extends Real {
      constructor(...args: unknown[]) {
        super(...((args.length ? args : [Real.now() + delta]) as [number]));
      }
      static now() {
        return Real.now() + delta;
      }
    } as DateConstructor;
  }, T);

  let log: typeof WET = [];
  let samWatermark: number | null = null;
  const pulls: number[] = [];
  await ctx.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === '/api/sync/barrier') body = { watermark: T, serverNow: T };
    else if (url.pathname === '/api/sync' && route.request().method() === 'GET') {
      const after = Number(url.searchParams.get('after'));
      pulls.push(after);
      const rows = log.filter((r) => r.seq > after);
      body = {
        versions: rows,
        next: rows.at(-1)?.seq ?? after,
        through: log.length,
        more: false,
        serverNow: T,
        devices: [
          { deviceId: SELF, memberName: 'Maya', watermark: T, lastSeenAt: T, removedAt: null },
          {
            deviceId: SAM,
            memberName: 'Sam',
            watermark: samWatermark,
            lastSeenAt: T,
            removedAt: null,
          },
        ],
      };
    } else body = { results: [], serverNow: T };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  const a = await ctx.newPage();
  const errors = watchErrors(a);
  await open(a, '/readings');
  await expect(wetDiapers(a)).toHaveText('Not assessed');

  // Sam's phone uploads six wet diapers and covers them. Tab B pulls them into the shared
  // store and moves the shared cursor past them.
  log = WET;
  samWatermark = T;
  const b = await ctx.newPage();
  await open(b, '/readings');
  await expect(wetDiapers(b)).toHaveText(/^6/);

  // Back in tab A: its pull starts at the shared cursor and comes back empty.
  await a.bringToFront();
  const sent = pulls.length;
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => pulls.slice(sent)).toContain(6);
  await expect(wetDiapers(a)).toHaveText(/^6/);
  expect(errors).toEqual([]);
  await ctx.close();
});
