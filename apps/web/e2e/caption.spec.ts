import { expect, test } from '@playwright/test';
import { MIN, phone, seed, STOOL, watchErrors, type Seeded } from './helpers.ts';

// #34: every caption glyph inside the dial clears every mark and the inner ring band, at 15 px
// or more, at 320/390 px, light and night, idle, running and paused, with the ring full of marks.

const CASES: Record<string, { now: string; ev: Seeded[] }> = {
  'idle-wide': {
    now: '2026-10-29T22:57:00-04:00',
    ev: [
      {
        type: 'breastfeed',
        at: '2026-10-29T10:58:00-04:00',
        data: { side: 'left', durationSeconds: 900 },
      },
    ],
  },
  'idle-short': {
    now: '2026-10-29T02:12:00-04:00',
    ev: [
      {
        type: 'breastfeed',
        at: '2026-10-29T01:11:00-04:00',
        data: { side: 'left', durationSeconds: 900 },
      },
    ],
  },
  running: {
    now: '2026-10-29T23:23:00-04:00',
    ev: [
      {
        type: 'breastfeed',
        at: '2026-10-29T22:08:00-04:00',
        data: {
          side: 'right',
          durationSeconds: null,
          segments: [{ side: 'right', seconds: null }],
        },
      },
    ],
  },
  'running-hours': {
    now: '2026-10-29T23:58:00-04:00',
    ev: [
      {
        type: 'breastfeed',
        at: '2026-10-29T21:48:00-04:00',
        data: { side: 'left', durationSeconds: null, segments: [{ side: 'left', seconds: null }] },
      },
    ],
  },
  paused: {
    now: '2026-10-29T22:58:00-04:00',
    ev: [
      {
        type: 'breastfeed',
        at: '2026-10-29T22:18:00-04:00',
        data: {
          side: 'right',
          durationSeconds: null,
          segments: [{ side: 'right', seconds: null }],
          pausedAt: '2026-10-30T02:48:00.000Z',
          pausedSeconds: 0,
        },
      },
    ],
  },
};

/** A wet or dirty diaper every 36 minutes over the dial's 24 hours. */
function ring(now: string): Seeded[] {
  const out: Seeded[] = [];
  for (let m = 6, i = 0; m < 24 * 60; m += 36, i++) {
    out.push({
      type: 'diaper',
      at: Date.parse(now) - m * MIN,
      data: i % 2 ? { kind: 'wet' } : { kind: 'dirty', stool: STOOL },
    });
  }
  return out;
}

for (const width of [320, 390] as const) {
  for (const theme of ['light', 'night'] as const) {
    for (const [name, c] of Object.entries(CASES)) {
      test(`caption clears the ring: ${width} ${theme} ${name}`, async ({ browser }) => {
        const ctx = await phone(browser, width, theme);
        const page = await ctx.newPage();
        const errors = watchErrors(page);
        await page.clock.install({ time: new Date(c.now) });
        await seed(page, [...ring(c.now), ...c.ev]);
        await page.locator('.dial .center').waitFor();
        // A running timer rewrites its caption every second; measure after a refit.
        if (name.startsWith('running')) await page.clock.runFor(3000);
        await page.waitForTimeout(300);
        const m = await page.evaluate(() => {
          const svg = document.querySelector('.dial svg')!.getBoundingClientRect();
          const s = svg.width / 300;
          const cx = svg.left + svg.width / 2;
          const cy = svg.top + svg.height / 2;
          const marks = [...document.querySelectorAll('[data-mark]')].map((e) =>
            e.getBoundingClientRect(),
          );
          // Inner marks sit on r=99 and reach 99 - 5.5√2 (a dirty square's corner) inward.
          const band = (99 - 5.5 * Math.SQRT2) * s;
          const rows: { text: string; size: number }[] = [];
          const hits = new Set<string>();
          let gap = Infinity;
          for (const row of document.querySelector('.dial .center')!.children) {
            rows.push({
              text: (row as HTMLElement).innerText,
              size: parseFloat(getComputedStyle(row).fontSize),
            });
            const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            for (let n = walk.nextNode(); n; n = walk.nextNode()) {
              if (!n.textContent?.trim() || !n.parentElement?.getClientRects().length) continue;
              const range = document.createRange();
              range.selectNodeContents(n);
              for (const g of range.getClientRects()) {
                if (!g.width) continue;
                const corners = [
                  [g.left, g.top],
                  [g.right, g.top],
                  [g.left, g.bottom],
                  [g.right, g.bottom],
                ] as const;
                gap = Math.min(
                  gap,
                  band - Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy))),
                );
                for (const k of marks) {
                  if (g.left < k.right && g.right > k.left && g.top < k.bottom && g.bottom > k.top)
                    hits.add(n.textContent);
                }
              }
            }
          }
          return {
            rows,
            hits: [...hits],
            marks: marks.length,
            gap,
            scroll: document.documentElement.scrollWidth - innerWidth,
          };
        });
        expect(m.marks, 'the ring is full').toBeGreaterThanOrEqual(38);
        expect(m.hits, 'caption text over a mark').toEqual([]);
        expect(m.gap, 'caption reaches into the ring band').toBeGreaterThanOrEqual(0);
        expect(
          m.rows.filter((r) => r.size < 15),
          'caption rows under 15 px',
        ).toEqual([]);
        expect(m.scroll).toBe(0);
        expect(errors).toEqual([]);
        await ctx.close();
      });
    }
  }
}
