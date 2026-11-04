import { expect, test } from '@playwright/test';
import { audit } from './audit.ts';
import { open, overflow, phone, watchErrors } from './helpers.ts';

// First launch (#86): the welcome screen shows once, on a phone with no baby that is not
// signed in, and never otherwise. The doors only open Setup on the right step; the join and
// passkey logic is untouched.

const SELF = '01JBQ7Z9X8Y6W5V4T3S2R1Q0PS';

for (const width of [320, 390] as const) {
  for (const theme of ['light', 'night'] as const) {
    test(`first launch shows the welcome screen once: ${width} ${theme}`, async ({ browser }) => {
      const ctx = await phone(browser, width, theme, { baby: false });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await open(page, '/');
      await expect(page.getByRole('heading', { name: 'SMT/Baby' })).toBeVisible();
      await expect(page.getByText('Sovereign Medical Technology')).toBeVisible();
      // The type rules (text.spec.ts) on this screen too; the 11 px eyebrow is its one exception.
      const found = { ...(await page.evaluate(audit)), scroll: (await overflow(page)).scroll };
      expect(found).toEqual({ small: [], faint: [], controls: [], scroll: 0 });
      // Both doors fit on screen with the main action in the thumb zone.
      const go = await page.locator('button.go').boundingBox();
      expect(go!.y + go!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      // The production build, as it renders, kept in test-results (CI could upload them).
      await page.screenshot({ path: test.info().outputPath(`welcome-${width}-${theme}.png`) });

      await page.getByRole('button', { name: 'Start a household' }).tap();
      await expect(page.getByRole('heading', { name: 'Add a baby' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start a household' })).toHaveCount(0);
      // Once passed, a reload lands on Add a baby.
      await page.reload();
      await page.locator('main').first().waitFor();
      await expect(page.getByRole('heading', { name: 'Add a baby' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'SMT/Baby' })).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('bht.welcomed'))).toBe('1');
      expect(errors).toEqual([]);
      await ctx.close();
    });
  }
}

test('Join with a code opens Setup on the invite code', async ({ browser }) => {
  const ctx = await phone(browser, 390, 'light', { baby: false });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await open(page, '/');
  await page.getByRole('button', { name: 'Join with a code' }).tap();
  await expect(page.getByRole('heading', { name: 'Add a baby' })).toBeVisible();
  await expect(page.getByLabel('Invite code')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join with a passkey' })).toBeVisible();
  await expect(
    page.getByText("Make an invite code in Settings on the other parent's phone."),
  ).toBeVisible();
  // The way back is the same as before #86.
  await page.getByRole('button', { name: 'Add a baby instead' }).tap();
  await expect(page.getByLabel('Name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join the other parent ›' })).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a phone with a baby never sees it', async ({ browser }) => {
  const ctx = await phone(browser, 390);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await open(page, '/');
  await page.locator('.rail').waitFor();
  await expect(page.getByRole('heading', { name: 'SMT/Baby' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('bht.welcomed'))).toBeNull();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a signed-in phone with no baby goes to Add a baby, not the welcome screen (#85)', async ({
  browser,
}) => {
  const ctx = await phone(browser, 390, 'light', { baby: false });
  // A household this phone belongs to, with no baby stored: the state after a clear.
  await ctx.addInitScript(
    ([household, self]) => {
      localStorage.setItem(
        'bht.account',
        JSON.stringify({ householdId: household, memberId: self }),
      );
      localStorage.setItem('bht.author', self);
    },
    ['01JBQ7Z9X8Y6W5V4T3S2R1Q0PM', SELF] as const,
  );
  // No server behind the preview: sync answers fail, and the screen must not depend on them.
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: '' }));
  const page = await ctx.newPage();
  await open(page, '/');
  await expect(page.getByRole('heading', { name: 'Add a baby' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'SMT/Baby' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start a household' })).toHaveCount(0);
  await ctx.close();
});
