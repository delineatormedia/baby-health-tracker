import { newId, type BabyEvent } from '@bht/schema';
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Dial from './Dial.svelte';
import { dialFace, RING } from './dial.ts';
import { polar } from './logic.ts';

// The dial as Chrome paints it (#57 review): which mark ends up on top is the browser's call,
// not the face's. Uses an installed Chrome or Chromium; BHT_CHROME overrides. CI must have one.
const CHROME = [
  process.env.BHT_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!CHROME && process.env.CI) throw new Error('No Chrome for the browser test; set BHT_CHROME');

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
/** The app's colours and the dial's own sizing rules (plain CSS; `:global` rules drop out). */
const css = read('../../app.css') + read('./Dial.svelte').match(/<style>([\s\S]*)<\/style>/)![1];

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const MIN = 60_000;

function feed(minutesAgo: number, left: number, right: number): BabyEvent {
  const iso = new Date(NOW - minutesAgo * MIN).toISOString();
  const id = newId();
  return {
    id,
    babyId: id,
    authorId: id,
    occurredAt: iso,
    recordedAt: iso,
    version: 1,
    deleted: false,
    notes: null,
    type: 'breastfeed',
    data: {
      side: 'both',
      durationSeconds: (left + right) * 60,
      segments: [
        { side: 'left', seconds: left * 60 },
        { side: 'right', seconds: right * 60 },
      ],
    },
  } as BabyEvent;
}

describe.skipIf(!CHROME)('the dial in a real browser', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: CHROME!, headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  // Short feeds put the switch inside an end cap's radius: 5+5 minutes is 2.9 units from each end.
  test.each([
    { width: 320, left: 5, right: 5 },
    { width: 390, left: 5, right: 5 },
    { width: 320, left: 1, right: 9 },
    { width: 390, left: 9, right: 1 },
  ])('a $left+$right-minute feed keeps its side-switch gap at $width px', async (c) => {
    const face = dialFace([feed(45, c.left, c.right)], NOW);
    const [arc] = face.arcs;
    expect(arc!.switches).toHaveLength(1);
    const { body } = render(Dial, {
      props: { face, children: createRawSnippet(() => ({ render: () => '<span></span>' })) },
    });
    const page = await browser.newPage({ viewport: { width: c.width, height: 844 } });
    try {
      await page.setContent(`<style>${css}</style>${body}`);
      const [x, y] = polar(arc!.switches[0]!, RING.feed);
      const hit = await page.evaluate(
        ([x, y]) => {
          const svg = document.querySelector('.dial svg') as SVGSVGElement;
          const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
          const e = document.elementFromPoint(p.x, p.y);
          return { gap: e?.hasAttribute('data-gap'), stroke: e?.getAttribute('stroke') };
        },
        [x, y] as const,
      );
      expect(hit).toEqual({ gap: true, stroke: 'var(--bg)' });
    } finally {
      await page.close();
    }
  });
});
