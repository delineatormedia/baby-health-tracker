import { expect, test } from '@playwright/test';
import { phone, seed, STOOL, watchErrors, type Seeded } from './helpers.ts';

// #34 / #51: the dial draws one mark per wet and dirty entry, except that taps of one kind
// within 2 minutes share a mark with a ×N count, so marks plus counts equal the legend. No two
// inner-ring marks overlap.

const NOW = '2026-10-29T02:59:00-04:00';
const at = (s: string) => `2026-10-${s}-04:00`;

const SEPARATE: Seeded[] = [
  { type: 'breastfeed', at: at('29T01:40:00'), data: { side: 'left', durationSeconds: 900 } },
  { type: 'diaper', at: at('29T02:05:00'), data: { kind: 'mixed', stool: STOOL } },
  // A wet and a dirty at the same minute sit side by side.
  { type: 'diaper', at: at('28T20:00:00'), data: { kind: 'wet' } },
  { type: 'diaper', at: at('28T20:00:00'), data: { kind: 'dirty', stool: STOOL } },
  // More than one step (about 37 min) from the pair: #51 never moves a mark of one kind, so a
  // wet a few minutes after a spread pair can still touch it (accepted in #51).
  { type: 'diaper', at: at('28T21:00:00'), data: { kind: 'wet' } },
  { type: 'diaper', at: at('28T14:00:00'), data: { kind: 'wet' } },
  { type: 'bottle', at: at('29T00:09:00'), data: { contents: 'breast_milk', volumeMl: 60 } },
  {
    type: 'pump',
    at: at('28T22:00:00'),
    // Logged without the timer, so a diamond rather than an arc.
    data: { leftMl: 40, rightMl: 30, afterFeed: false },
  },
];

// Three wet taps 40 s apart: one mark, ×3.
const BURST: Seeded[] = [
  ...SEPARATE,
  { type: 'diaper', at: at('28T09:00:00'), data: { kind: 'wet' } },
  { type: 'diaper', at: at('28T09:00:40'), data: { kind: 'wet' } },
  { type: 'diaper', at: at('28T09:01:20'), data: { kind: 'wet' } },
];

function face() {
  const marks = [...document.querySelectorAll('[data-mark]')].map((m) => {
    const kind = m.getAttribute('data-mark')!;
    const n = (a: string) => Number(m.getAttribute(a));
    return m.tagName === 'circle'
      ? { kind, x: n('cx'), y: n('cy'), r: n('r') }
      : {
          kind,
          x: n('x') + n('width') / 2,
          y: n('y') + n('height') / 2,
          r: (n('width') / 2) * Math.SQRT2,
        };
  });
  const inner = marks.filter((m) => m.kind === 'wet' || m.kind === 'dirty');
  const overlaps: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    for (let j = i + 1; j < inner.length; j++) {
      const a = inner[i]!;
      const b = inner[j]!;
      // Disjoint if their circumscribed circles are (dial units).
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) overlaps.push(`${a.kind}/${b.kind}`);
    }
  }
  const count = (k: string) => marks.filter((m) => m.kind === k).length;
  const legend = Object.fromEntries(
    [...document.querySelectorAll('.legend span')].map((s) => [
      s.textContent!.replace(/\d+/, '').trim(),
      Number(s.querySelector('b')!.textContent),
    ]),
  );
  const extra = [...document.querySelectorAll('[data-count]')]
    .map((t) => Number(t.textContent!.replace('×', '')) - 1)
    .reduce((a, b) => a + b, 0);
  return {
    marks: {
      wet: count('wet'),
      dirty: count('dirty'),
      bottle: count('bottle'),
      pump: count('pump'),
    },
    extra,
    legend,
    overlaps,
    counts: [...document.querySelectorAll('[data-count]')].map((t) => t.textContent),
  };
}

for (const width of [320, 390] as const) {
  for (const theme of ['light', 'night'] as const) {
    test(`marks match the legend, no overlaps: ${width} ${theme}`, async ({ browser }) => {
      const ctx = await phone(browser, width, theme);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(new Date(NOW));
      await seed(page, SEPARATE);
      await page.locator('.legend').waitFor();
      const f = await page.evaluate(face);
      expect(f.counts).toEqual([]);
      expect(f.marks).toEqual({
        wet: f.legend.Wet,
        dirty: f.legend.Dirty,
        bottle: f.legend.Bottle,
        pump: f.legend.Pump,
      });
      expect(f.legend).toMatchObject({ Wet: 4, Dirty: 2, Bottle: 1, Pump: 1 });
      expect(f.overlaps).toEqual([]);
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test(`a burst is one mark with its count: ${width} ${theme}`, async ({ browser }) => {
      const ctx = await phone(browser, width, theme);
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.clock.setFixedTime(new Date(NOW));
      await seed(page, BURST);
      await page.locator('.legend').waitFor();
      const f = await page.evaluate(face);
      expect(f.counts).toEqual(['×3']);
      expect(f.legend.Wet).toBe(7);
      expect(f.marks.wet + f.extra).toBe(f.legend.Wet);
      expect(f.marks.dirty).toBe(f.legend.Dirty);
      expect(f.overlaps).toEqual([]);
      expect(errors).toEqual([]);
      await ctx.close();
    });
  }
}
