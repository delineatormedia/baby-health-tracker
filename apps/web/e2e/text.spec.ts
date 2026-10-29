import { expect, test } from '@playwright/test';
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

/** Runs in the page: every visible text node's size and contrast, and each control's label size. */
function audit() {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const rgba = (c: string) => {
    const m = (c.match(/[\d.]+/g) ?? []).map(Number);
    // color(srgb r g b / a) reports 0-1 channels.
    const [r, g, b] = c.startsWith('color(') ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3);
    const a = c.startsWith('color(') ? (m[3] ?? 1) : (m[3] ?? 1);
    return { r: r!, g: g!, b: b!, a };
  };
  const lum = (c: { r: number; g: number; b: number }) =>
    0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (fg: string, bg: string) => {
    const back = rgba(bg);
    const f = rgba(fg);
    // Blend a translucent colour over the background it sits on.
    const mix = {
      r: f.r * f.a + back.r * (1 - f.a),
      g: f.g * f.a + back.g * (1 - f.a),
      b: f.b * f.a + back.b * (1 - f.a),
    };
    const [x, y] = [lum(mix), lum(back)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const background = (el: Element | null): string => {
    for (let e = el; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (rgba(bg).a > 0) return bg;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  };
  const disabled = (el: Element) => !!el.closest('[disabled], [aria-disabled="true"]');

  const small: string[] = [];
  const faint: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.textContent?.trim();
    const el = n.parentElement;
    if (!t || !el || !visible(el) || el.closest('script, style, [aria-hidden="true"]:not(svg)'))
      continue;
    const cs = getComputedStyle(el);
    const svg = el.closest('svg');
    // SVG text is drawn in a 300-unit viewBox scaled to the dial.
    const size = svg
      ? parseFloat(cs.fontSize) * (svg.getBoundingClientRect().width / svg.viewBox.baseVal.width)
      : parseFloat(cs.fontSize);
    if (size < 15 - 1e-6) small.push(`${t.slice(0, 30)} @${size.toFixed(1)}`);
    if (disabled(el)) continue;
    const r = ratio(svg ? cs.fill : cs.color, background(el));
    if (r < 4.5) faint.push(`${t.slice(0, 30)} ${r.toFixed(2)}`);
  }

  const controls: string[] = [];
  const tappable =
    'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, summary';
  for (const el of document.querySelectorAll(tappable)) {
    if (!visible(el) || el.matches('.dial-link')) continue;
    // A transparent native picker laid over its label: the label is the control's text.
    if (el instanceof HTMLInputElement && getComputedStyle(el).opacity === '0') continue;
    const sizes = [el, ...el.querySelectorAll('*')]
      .filter((e) => [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim()))
      .map((e) => parseFloat(getComputedStyle(e).fontSize));
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    )
      sizes.push(parseFloat(getComputedStyle(el).fontSize));
    if (sizes.length && Math.max(...sizes) < 20 - 1e-6) {
      controls.push(
        `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" @${Math.max(...sizes)}`,
      );
    }
  }
  return { small, faint, controls };
}

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
