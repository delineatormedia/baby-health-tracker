import { expect, test, type Page } from '@playwright/test';
import {
  current,
  MIN,
  open,
  overflow,
  phone,
  seed,
  STOOL,
  until,
  versions,
  watchErrors,
  type Seeded,
} from './helpers.ts';

// Core flows from the WebKit pass on b5c1347, against the production build. State is read
// back from IndexedDB, never from app internals.

const T = Date.parse('2026-10-29T16:00:00Z');
const SEED: Seeded[] = [
  { type: 'diaper', at: T - 200 * MIN, data: { kind: 'wet' } },
  { type: 'diaper', at: T - 150 * MIN, data: { kind: 'dirty', stool: STOOL } },
  { type: 'bottle', at: T - 100 * MIN, data: { contents: 'formula', volumeMl: 60 } },
  { type: 'breastfeed', at: T - 50 * MIN, data: { side: 'left', durationSeconds: 600 } },
  { type: 'weight', at: T - 30 * MIN, data: { grams: 3610, source: 'home' } },
];

/** Moves the fixed clock and lets the app's once-a-second tick pick it up. */
async function time(page: Page, ms: number) {
  await page.clock.setFixedTime(ms);
  await page.waitForTimeout(1100);
}

/** Sets a native date/time input the way a picker does. */
async function pick(page: Page, label: string, value: string) {
  const input = page.getByLabel(label);
  await input.fill(value);
  // WebKit fires change on fill, and the screen may close the picker before a second one.
  await input.dispatchEvent('change', undefined, { timeout: 1000 }).catch(() => {});
}

for (const width of [320, 390] as const) {
  test.describe(`flows at ${width}`, () => {
    test('setup through the UI survives a reload', async ({ browser }) => {
      const ctx = await phone(browser, width, 'light', { baby: false });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(T);
      await open(page, '/');
      await page.locator('input:not([type])').first().fill('Webkit Baby');
      await page.locator('input[type="datetime-local"]').fill('2026-10-20T08:15');
      await page.getByRole('button', { name: 'Female', exact: true }).tap();
      await page.locator('button.go').tap();
      await page.locator('.rail').waitFor();
      const baby = () => page.evaluate(() => JSON.parse(localStorage.getItem('bht.baby')!));
      expect(await baby()).toMatchObject({
        name: 'Webkit Baby',
        birthAt: '2026-10-20T12:15:00.000Z',
      });
      await page.reload();
      await page.locator('.rail').waitFor();
      expect((await baby()).name).toBe('Webkit Baby');
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test('quick taps: Wet and Undo, Dirty in two taps, Feed in two', async ({ browser }) => {
      const ctx = await phone(browser, width);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(T);
      await seed(page, SEED);
      const diapers = () => current(page, 'diaper');
      const n0 = (await diapers()).length;
      await page.getByRole('button', { name: /^Wet/ }).tap();
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      await until(page, diapers, (d) => d.length === n0 + 1);
      await page.getByRole('button', { name: 'Undo', exact: true }).tap();
      await page.getByText('Undone', { exact: true }).waitFor();
      await until(page, diapers, (d) => d.length === n0);
      await page.getByRole('button', { name: /^Dirty/ }).tap();
      await page.getByRole('button', { name: 'Yellow', exact: true }).tap();
      await page.waitForURL(/diaper\/details/);
      await until(page, diapers, (d) =>
        d.some((e) => (e.data.stool as { color?: string } | null)?.color === 'yellow'),
      );
      await open(page, '/');
      await page.getByRole('button', { name: /^Feed/ }).tap();
      await page.locator('.sides button').first().tap();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await until(
        page,
        () => current(page, 'breastfeed'),
        (f) => f.some((e) => e.data.durationSeconds === null),
      );
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test('feed timer: reload, pause, switch side, stop', async ({ browser }) => {
      const ctx = await phone(browser, width);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(T);
      await open(page, '/feed');
      await page.getByRole('button', { name: /^Left/ }).tap();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await time(page, T + 4 * MIN);
      await page.reload();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await expect(page.locator('.big .v')).toHaveText(/04:0\d/);
      await page.getByRole('button', { name: 'Pause', exact: true }).tap();
      await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
      await time(page, T + 7 * MIN);
      await page.reload();
      await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
      await expect(page.locator('.big .v')).toHaveText(/04:0\d/);
      await page.getByRole('button', { name: 'Resume', exact: true }).tap();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await page.getByRole('button', { name: /^Right/ }).tap();
      const feed = async () => (await current(page, 'breastfeed'))[0]!;
      let f = await until(page, feed, (e) => (e.data.segments as unknown[]).length === 2);
      expect(f.data.segments).toEqual([
        { side: 'left', seconds: 240 },
        { side: 'right', seconds: null },
      ]);
      expect(f.data.pausedSeconds).toBe(180);
      await time(page, T + 12 * MIN);
      await page.reload();
      await page.getByRole('button', { name: /^Stop/ }).tap();
      await page.waitForURL((u) => u.pathname === '/');
      f = await until(page, feed, (e) => e.data.durationSeconds !== null);
      expect(f.data.durationSeconds).toBe(540);
      expect(f.data.segments).toEqual([
        { side: 'left', seconds: 240 },
        { side: 'right', seconds: 300 },
      ]);
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test('pump: stop, reload, add the amount from Home', async ({ browser }) => {
      const ctx = await phone(browser, width);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(T);
      await open(page, '/pump');
      await page
        .getByRole('button', { name: /^Start/ })
        .first()
        .tap();
      await page.getByRole('button', { name: /^Stop/ }).waitFor();
      await time(page, T + 25 * MIN);
      await page.getByRole('button', { name: /^Stop/ }).tap();
      await page.getByRole('slider', { name: 'Left amount' }).waitFor();
      await page.reload();
      await page.getByRole('slider', { name: 'Left amount' }).waitFor();
      await open(page, '/');
      await page.getByRole('button', { name: /^Pump.*Add amount/ }).tap();
      const slider = page.getByRole('slider', { name: 'Left amount' });
      const box = (await slider.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByRole('button', { name: /^Log L / }).tap();
      await page.waitForURL((u) => u.pathname === '/');
      const pumps = await until(
        page,
        () => current(page, 'pump'),
        (p) => p[0]?.version === 3,
      );
      expect(pumps).toHaveLength(1);
      expect(pumps[0]!.data.durationSeconds).toBe(1500);
      expect(pumps[0]!.data.leftMl).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test('time pickers: backdated bottle, feed start, day start, report date', async ({
      browser,
    }) => {
      const ctx = await phone(browser, width);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(T);
      await open(page, '/bottle');
      await page.locator('.trow .row').first().tap();
      // The native picker: a transparent input laid over "Other time ›".
      await pick(page, 'Pick a time', '2026-10-29T09:05');
      await page.locator('button.go').tap();
      await page.waitForURL((u) => u.pathname === '/');
      const [bottle] = await until(
        page,
        () => current(page, 'bottle'),
        (b) => b.length === 1,
      );
      expect(bottle!.occurredAt).toBe('2026-10-29T13:05:00.000Z');

      await open(page, '/feed');
      await page.getByRole('button', { name: /^Left/ }).tap();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await pick(page, 'Change the start time', '2026-10-29T11:40');
      await until(
        page,
        () => current(page, 'breastfeed'),
        (f) => f[0]?.occurredAt === '2026-10-29T15:40:00.000Z',
      );

      await open(page, '/settings');
      await pick(page, 'Other day start time', '03:00');
      await expect
        .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('bht.prefs')!).dayStart))
        .toBe(180);

      await open(page, '/reports');
      await pick(page, 'Pick a date', '2026-10-27');
      await expect(page.locator('.period b')).toContainText('27');
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test('history: edit and delete, each undone, through reloads', async ({ browser }) => {
      const ctx = await phone(browser, width);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(T);
      await seed(page, SEED, '/history');
      const id = (await current(page, 'weight'))[0]!.id;
      const held = async () => (await versions(page)).get(id)!;
      await page
        .locator('.list a')
        .filter({ hasText: /Weight/ })
        .first()
        .tap();
      await page.locator('.trow .row').tap();
      await page.getByRole('button', { name: '−1 h', exact: true }).tap();
      await page.getByRole('button', { name: 'Save', exact: true }).tap();
      await page.waitForURL((u) => u.pathname === '/history');
      let v = await until(page, held, (v) => v.length === 2);
      expect(v.at(-1)!.occurredAt).toBe(new Date(T - 60 * MIN).toISOString());
      await page.getByRole('button', { name: 'Undo', exact: true }).tap();
      await page.getByText('Undone', { exact: true }).waitFor();
      await page.reload();
      v = await until(page, held, (v) => v.length === 3);
      expect(v.at(-1)!.occurredAt).toBe(v[0]!.occurredAt);
      await page
        .locator('.list a')
        .filter({ hasText: /Weight/ })
        .first()
        .tap();
      await page.getByRole('button', { name: 'Delete', exact: true }).tap();
      await page.waitForURL((u) => u.pathname === '/history');
      await page.getByRole('button', { name: 'Undo', exact: true }).tap();
      await page.getByText('Undone', { exact: true }).waitFor();
      await page.reload();
      v = await until(page, held, (v) => v.length === 5);
      expect(v.at(-1)!.deleted).toBe(false);
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test('weight in lb/oz', async ({ browser }) => {
      const ctx = await phone(browser, width);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(T);
      await open(page, '/weight');
      for (const d of '3610') await page.getByRole('button', { name: d, exact: true }).tap();
      await page.getByRole('button', { name: 'lb/oz', exact: true }).tap();
      await expect(page.getByLabel('Pounds')).toHaveValue('7');
      await page.getByLabel('Pounds').fill('8');
      await page.getByLabel('Ounces').fill('4.5');
      expect((await overflow(page)).scroll).toBe(0);
      await page.locator('button.go').tap();
      await page.waitForURL((u) => u.pathname === '/');
      const [w] = await until(
        page,
        () => current(page, 'weight'),
        (w) => w.length === 1,
      );
      expect(Math.round(w!.data.grams as number)).toBe(Math.round((8 * 16 + 4.5) * 28.349523125));
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test('reports count the 25 h and 23 h DST days', async ({ browser }) => {
      const ctx = await phone(browser, width);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(Date.parse('2027-03-15T16:00:00Z'));
      await seed(page, [
        { type: 'diaper', at: '2026-11-01T08:00:00.000Z', data: { kind: 'wet' } },
        { type: 'diaper', at: '2027-03-14T07:00:00.000Z', data: { kind: 'wet' } },
      ]);
      for (const [day, hours] of [
        ['2026-11-01', '25 h'],
        ['2027-03-14', '23 h'],
      ] as const) {
        await open(page, '/reports');
        await pick(page, 'Pick a date', day);
        await expect(page.locator('.stepper')).toContainText(new RegExp(hours, 'i'));
        await expect(page.locator('.sum').first()).toContainText(/1\s*wet/);
      }
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test('a log survives closing the page', async ({ browser }) => {
      const ctx = await phone(browser, width);
      const page = await ctx.newPage();
      await page.clock.setFixedTime(T);
      await open(page, '/');
      await page.getByRole('button', { name: /^Wet/ }).tap();
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      const [wet] = await until(
        page,
        () => current(page, 'diaper'),
        (d) => d.length === 1,
      );
      await page.close();
      const again = await ctx.newPage();
      await open(again, '/history');
      await expect(again.locator('.list a').filter({ hasText: /Wet/ })).toHaveCount(1);
      expect((await current(again, 'diaper'))[0]!.id).toBe(wet!.id);
      await ctx.close();
    });
  });
}
