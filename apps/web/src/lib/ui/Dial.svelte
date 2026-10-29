<script lang="ts">
  import type { Snippet } from 'svelte';
  import { CAPTION_RADIUS, chordWidth, innerMarks, polar, type Mark } from './logic.ts';

  let {
    marks,
    running,
    now,
    children,
  }: { marks: Mark[]; running: string | null; now: number; children: Snippet } = $props();

  const hourOf = (ms: number) => {
    const d = new Date(ms);
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  };

  /** The running feed as an arc from its start to now (capped at a full turn). */
  const arc = $derived.by(() => {
    if (running === null) return null;
    const start = Date.parse(running);
    const h0 = hourOf(Math.max(start, now - 23.9 * 3_600_000));
    let h1 = hourOf(now);
    if (h1 < h0) h1 += 24;
    if (h1 - h0 < 0.12) h1 = h0 + 0.12;
    const [x0, y0] = polar(h0, 134);
    const [x1, y1] = polar(h1, 134);
    return `M${x0} ${y0} A134 134 0 ${h1 - h0 > 12 ? 1 : 0} 1 ${x1} ${y1}`;
  });
  // Wet and dirty marks spread side by side where they would overlap (a mixed diaper is both).
  const inner = $derived(innerMarks(marks));
  const hand = $derived(polar(hourOf(now), 146));

  let dial: HTMLDivElement;
  let center: HTMLDivElement;

  /**
   * Keeps every caption row inside the inner ring: each row may be as wide as the ring's chord
   * at its farthest edge. A row of `.alt` spans shows the first that fits (fullest first), a
   * `data-fit="shrink"` row scales its type down to fit, and anything still too wide
   * ellipsizes. Rows never wrap and only ever get shorter, so every row stays where it was
   * measured or moves toward the centre, where the chord is wider.
   */
  function fit() {
    const box = dial.getBoundingClientRect();
    const radius = (CAPTION_RADIUS / 300) * box.width;
    const cy = box.top + box.height / 2;
    for (const row of center.children) {
      if (!(row instanceof HTMLElement)) continue;
      row.style.fontSize = '';
      const alts = [...row.children].filter((c) => c instanceof HTMLElement && c.matches('.alt'));
      alts.forEach((alt, i) => ((alt as HTMLElement).style.display = i === 0 ? 'inline' : 'none'));
      const { top, bottom } = row.getBoundingClientRect();
      // Whole pixels, so the comparisons below agree with scrollWidth.
      const width = Math.floor(chordWidth(radius, top - cy, bottom - cy));
      row.style.maxWidth = `${width}px`;
      for (let i = 1; i < alts.length && row.scrollWidth > width; i++) {
        (alts[i - 1] as HTMLElement).style.display = 'none';
        (alts[i] as HTMLElement).style.display = 'inline';
      }
      if (row.dataset.fit === 'shrink' && row.scrollWidth > width) {
        let size = parseFloat(getComputedStyle(row).fontSize);
        size = Math.floor(((size * width) / row.scrollWidth) * 2) / 2;
        row.style.fontSize = `${size}px`;
        // Glyph widths do not scale exactly with the size; step down until it fits.
        while (row.scrollWidth > width && size > 15) row.style.fontSize = `${(size -= 0.5)}px`;
      }
    }
  }

  $effect(() => {
    const resize = new ResizeObserver(fit);
    resize.observe(dial);
    // The running timer rewrites its caption every second; only text changes refit.
    const text = new MutationObserver(fit);
    text.observe(center, { childList: true, subtree: true, characterData: true });
    fit();
    return () => {
      resize.disconnect();
      text.disconnect();
    };
  });
</script>

<div class="dial" bind:this={dial}>
  <svg viewBox="0 0 300 300" aria-hidden="true">
    <circle cx="150" cy="150" r="140" fill="none" stroke="var(--line)" stroke-width="1.5" />
    <circle
      cx="150"
      cy="150"
      r="99"
      fill="none"
      stroke="var(--line)"
      stroke-width="1"
      stroke-dasharray="2 5"
    />
    {#each [0, 6, 12, 18] as h (h)}
      {@const [a, b] = polar(h, 140)}
      {@const [x, y] = polar(h, 131)}
      {@const [tx, ty] = polar(h, 115)}
      <line x1={a} y1={b} x2={x} y2={y} stroke="var(--dim)" stroke-width="1.5" />
      <text x={tx} y={ty + 6} text-anchor="middle" class="h">{h}</text>
    {/each}
    <!-- Each kind has its own colour and shape, as on the keys: feeds and bottles share the
         outer ring, wet and dirty the inner one, so the dial still reads without colour. -->
    {#each marks as m, i (i)}
      {#if m.kind === 'feed'}
        {@const [a, b] = polar(m.hour, 141)}
        {@const [x, y] = polar(m.hour, 126)}
        <line
          x1={a}
          y1={b}
          x2={x}
          y2={y}
          stroke="var(--feed)"
          stroke-width="6"
          stroke-linecap="round"
        />
      {:else if m.kind === 'bottle'}
        {@const [x, y] = polar(m.hour, 134)}
        <circle cx={x} cy={y} r="6" fill="var(--panel)" stroke="var(--bottle)" stroke-width="3" />
      {/if}
    {/each}
    {#if arc}
      <path d={arc} stroke="var(--feed)" stroke-width="14" fill="none" stroke-linecap="round" />
    {/if}
    {#each inner as m, i (i)}
      {@const [x, y] = polar(m.at, 99)}
      {#if m.kind === 'wet'}
        <circle cx={x} cy={y} r="5.5" fill="var(--wet)" data-mark="wet" />
      {:else}
        <rect
          x={x - 5.5}
          y={y - 5.5}
          width="11"
          height="11"
          rx="1"
          fill="var(--dirty)"
          data-mark="dirty"
        />
      {/if}
    {/each}
    <circle cx={hand[0]} cy={hand[1]} r="3.5" fill="var(--dim)" />
  </svg>
  <div class="center" bind:this={center}>{@render children()}</div>
</div>

<style>
  .dial {
    position: relative;
    width: min(300px, 78vw);
    aspect-ratio: 1;
    margin: 22px auto 0;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  /* 18.5 units: the dial is 300 units but as small as 249.6 px (78vw at 320), so 15.4 px. */
  .h {
    font: 18.5px var(--mono);
    fill: var(--text-dim);
  }
  .center {
    position: absolute;
    inset: 18%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .center > :global(*) {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .center :global(.alt + .alt) {
    display: none;
  }
</style>
