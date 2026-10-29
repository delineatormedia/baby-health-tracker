import { expect, test } from '@playwright/test';
import { audit } from './audit.ts';
import { MIN, overflow, phone, seed, STOOL, watchErrors, type Seeded } from './helpers.ts';

// #38 / #40 type rules on every screen (docs/design/README.md, Type sizes): nothing smaller
// than 15 px, every enabled text at least 4.5:1 against what is behind it, and every tappable
// control labelled at 20 px or more. Light and night, 320 and 390 px.

const NOW = Date.parse('2026-10-29T12:00:00-04:00');
const ago = (min: number) => NOW - min * MIN;

const SEED: Seeded[] = [
  { type: 'diaper', at: ago(200), data: { kind: 'wet' } },
  { type: 'diaper', at: ago(150), data: { kind: 'dirty', stool: STOOL } },
  { type: 'bottle', at: ago(100), data: { contents: 'formula', volumeMl: 60 } },
  { type: 'breastfeed', at: ago(50), data: { side: 'left', durationSeconds: 600 } },
  { type: 'weight', at: ago(30), data: { grams: 3610, source: 'home' } },
  {
    type: 'pump',
    at: ago(300),
    data: { leftMl: 40, rightMl: 30, afterFeed: false, side: 'both', durationSeconds: 900 },
  },
];
/** The dirty diaper's id: helpers.seed numbers ids in seed order. */
const DIRTY = '01JE2E00010000000000000000';

const ROUTES = [
  '/',
  '/feed',
  '/diaper',
  `/diaper/details?id=${DIRTY}`,
  '/bottle',
  '/pump',
  `/logged?id=${DIRTY}`,
  '/readings',
  '/settings',
  '/history',
  `/history/entry?id=${DIRTY}`,
  '/weight',
  '/reports',
];

for (const width of [320, 390] as const) {
  for (const theme of ['light', 'night'] as const) {
    test(`type sizes and contrast on every screen: ${width} ${theme}`, async ({ browser }) => {
      const ctx = await phone(browser, width, theme);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(NOW);
      await seed(page, SEED);
      const found: Record<string, ReturnType<typeof audit> & { scroll: number }> = {};
      for (const route of ROUTES) {
        await page.goto(route);
        await page.locator('main').first().waitFor();
        await page.waitForTimeout(250);
        found[route] = { ...(await page.evaluate(audit)), scroll: (await overflow(page)).scroll };
      }
      const bad = Object.fromEntries(
        Object.entries(found).filter(
          ([, f]) => f.small.length || f.faint.length || f.controls.length || f.scroll,
        ),
      );
      expect(bad).toEqual({});
      expect(errors).toEqual([]);
      await ctx.close();
    });
  }
}
