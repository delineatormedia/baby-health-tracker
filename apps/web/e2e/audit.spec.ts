import { expect, test, type Page } from '@playwright/test';
import { audit } from './audit.ts';
import { open, phone } from './helpers.ts';

// Negative controls for the contrast audit in text.spec.ts: each one breaks the readability
// of a single thing on /weight and expects the audit to name it. The baseline is checked
// first, so a control can't pass because the page was already failing.

const NOW = Date.parse('2026-10-29T12:00:00-04:00');

async function weight(page: Page, unit: 'g' | 'lb/oz' = 'g') {
  await page.clock.setFixedTime(NOW);
  await open(page, '/weight');
  if (unit === 'lb/oz') await page.getByRole('button', { name: 'lb/oz', exact: true }).click();
  await page.waitForTimeout(250);
  expect((await page.evaluate(audit)).faint).toEqual([]);
}

const faint = async (page: Page) => (await page.evaluate(audit)).faint;

test('an input value the colour of its background fails', async ({ browser }) => {
  const ctx = await phone(browser, 390);
  const page = await ctx.newPage();
  await weight(page, 'lb/oz');
  const pounds = page.getByLabel('Pounds');
  await pounds.fill('8');
  expect(await faint(page)).toEqual([]);
  await pounds.evaluate((el: HTMLElement) => {
    el.style.color = getComputedStyle(el).backgroundColor;
  });
  expect(await faint(page)).toEqual([expect.stringMatching(/^8 1\.00$/)]);
  await ctx.close();
});

test('a placeholder the colour of its background fails, only while it shows', async ({
  browser,
}) => {
  const ctx = await phone(browser, 390);
  const page = await ctx.newPage();
  await weight(page, 'lb/oz');
  const pounds = page.getByLabel('Pounds');
  await pounds.fill('');
  await pounds.evaluate((el: HTMLInputElement) => {
    el.placeholder = 'lb';
    const s = document.createElement('style');
    s.textContent = `input::placeholder { color: ${getComputedStyle(el).backgroundColor}; }`;
    document.head.append(s);
  });
  expect(await faint(page)).toEqual([expect.stringMatching(/^lb 1\.00$/)]);
  await pounds.fill('8');
  expect(await faint(page)).toEqual([]);
  await ctx.close();
});

test('a label at opacity 0.1 fails', async ({ browser }) => {
  const ctx = await phone(browser, 390);
  const page = await ctx.newPage();
  await weight(page);
  await page.getByRole('button', { name: 'lb/oz', exact: true }).evaluate((el: HTMLElement) => {
    el.style.opacity = '0.1';
  });
  expect(await faint(page)).toEqual([expect.stringMatching(/^lb\/oz \d\.\d\d$/)]);
  await ctx.close();
});

test("an ancestor's opacity counts against the text inside it", async ({ browser }) => {
  const ctx = await phone(browser, 390);
  const page = await ctx.newPage();
  await weight(page);
  await page.getByRole('button', { name: 'lb/oz', exact: true }).evaluate((el: HTMLElement) => {
    el.parentElement!.style.opacity = '0.1';
  });
  expect(await faint(page)).toContainEqual(expect.stringMatching(/^lb\/oz \d\.\d\d$/));
  await ctx.close();
});
