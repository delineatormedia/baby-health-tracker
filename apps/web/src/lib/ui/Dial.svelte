<script lang="ts">
  import type { Snippet } from 'svelte';
  import { CAPTION_RADIUS, chordWidth, polar } from './logic.ts';
  import { ARC_WIDTH, CASING, RING, arcParts, arcPath, type Arc, type DialFace } from './dial.ts';

  let { face, children }: { face: DialFace; children: Snippet } = $props();

  const radius = (a: Arc) => (a.kind === 'feed' ? RING.feed : RING.pump);
  const colour = (a: Arc) => (a.kind === 'feed' ? 'var(--feed)' : 'var(--pump)');

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
      {@const [a, b] = polar(h, RING.outline)}
      {@const [x, y] = polar(h, 131)}
      <line x1={a} y1={b} x2={x} y2={y} stroke="var(--dim)" stroke-width="1.5" />
    {/each}
    {#each face.numerals as h (h)}
      {@const [tx, ty] = polar(h, RING.label)}
      <text x={tx} y={ty + 6} text-anchor="middle" class="h">{h}</text>
    {/each}
    <!-- Feeds and pumps are arcs from start to end (#52), longest first so a shorter one on top
         shows both ends. Each has a casing in the page colour; a side switch is a gap. A session
         cut at the 24-hour edge has a flat end there; every other end is round. -->
    {#each face.arcs as a, i (i)}
      {@const r = radius(a)}
      {@const w = ARC_WIDTH[a.kind]}
      {@const [sx, sy] = polar(a.from, r)}
      {@const [ex, ey] = polar(a.to, r)}
      <g data-arc={a.kind}>
        <path
          d={arcPath(a.from, a.to, r)}
          stroke="var(--bg)"
          stroke-width={w + 2 * CASING}
          fill="none"
        />
        {#if !a.cut}<circle cx={sx} cy={sy} r={w / 2 + CASING} fill="var(--bg)" />{/if}
        <circle cx={ex} cy={ey} r={w / 2 + CASING} fill="var(--bg)" />
        {#each arcParts(a) as [lo, hi], k (k)}
          <path d={arcPath(lo, hi, r)} stroke={colour(a)} stroke-width={w} fill="none" />
        {/each}
        {#if !a.cut}<circle cx={sx} cy={sy} r={w / 2} fill={colour(a)} />{/if}
        <circle cx={ex} cy={ey} r={w / 2} fill={colour(a)} />
      </g>
    {/each}
    <!-- After the arcs: a feed's casing reaches past the outline. -->
    <circle
      cx="150"
      cy="150"
      r={RING.outline}
      fill="none"
      stroke="var(--line)"
      stroke-width="1.5"
    />
    <!-- Each kind has its own colour and shape, as on the keys. A burst of taps is one mark,
         with its count on the label ring (#51). -->
    {#each face.points as p, i (i)}
      {#if p.kind === 'bottle'}
        {@const [x, y] = polar(p.at, RING.feed)}
        <circle
          cx={x}
          cy={y}
          r="6"
          fill="var(--panel)"
          stroke="var(--bottle)"
          stroke-width="3"
          data-mark="bottle"
        />
      {:else if p.kind === 'pump'}
        {@const [x, y] = polar(p.at, RING.pump)}
        <rect
          x={x - 4}
          y={y - 4}
          width="8"
          height="8"
          fill="var(--pump)"
          transform="rotate(45 {x} {y})"
          data-mark="pump"
        />
      {:else if p.kind === 'wet'}
        {@const [x, y] = polar(p.at, RING.inner)}
        <circle cx={x} cy={y} r="5.5" fill="var(--wet)" data-mark="wet" />
      {:else}
        {@const [x, y] = polar(p.at, RING.inner)}
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
    {#each face.labels as l, i (i)}
      {@const [x, y] = polar(l.at, RING.label)}
      <text {x} y={y + 6} text-anchor="middle" class="count" data-count>{l.text}</text>
    {/each}
    <!-- "Now": a short radial line across the pump ring, where running sessions end. -->
    <line
      x1={polar(face.now, RING.outline + 1)[0]}
      y1={polar(face.now, RING.outline + 1)[1]}
      x2={polar(face.now, 150)[0]}
      y2={polar(face.now, 150)[1]}
      stroke="var(--dim)"
      stroke-width="2"
      data-now
    />
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
  .count {
    font: 18.5px var(--mono);
    fill: var(--ink);
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
