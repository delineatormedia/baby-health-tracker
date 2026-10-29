<script lang="ts">
  import LogKey from './LogKey.svelte';
  import { sideLine, type KeyLine } from './keys.ts';
  import { clock, currentSide, feedElapsed, isPaused, type Breastfeed } from './logic.ts';

  // The Feed key, idle or running. Everything the running state shows (the elapsed time and the
  // side) is worked out here, so a change to the timer (#29 Pause) only touches this file.
  let {
    running,
    lines,
    now,
    onstart,
    onstop,
  }: {
    running: Breastfeed | undefined;
    lines: readonly KeyLine[];
    now: number;
    onstart: () => void;
    onstop: () => void;
  } = $props();

  // Paused (#29), the clock holds and the key keeps its outline but drops the tint.
  const elapsed = $derived(running ? clock(feedElapsed(running, now)) : '');
  const paused = $derived(running ? isPaused(running) : false);
  const side = $derived(running ? sideLine(currentSide(running) ?? running.data.side) : null);
</script>

{#if running && side}
  <LogKey
    kind="feed"
    label="Stop"
    lines={[side]}
    tall
    running
    {paused}
    name="Stop the breastfeed, {paused ? 'paused at ' : ''}{elapsed}, {side.em}{side.rest}"
    onclick={onstop}
  >
    {#if paused}<small><em>Paused</em></small>{/if}
    <span class="clock num" class:long={elapsed.length > 5} class:held={paused}>{elapsed}</span>
    <small><em>{side.em}</em>{side.rest}</small>
  </LogKey>
{:else}
  <LogKey kind="feed" label="Feed" {lines} tall onclick={onstart} />
{/if}

<style>
  /* Sized to the key, so the clock fits a 320 px screen, and smaller again past an hour. */
  .clock {
    font: 300 min(34px, 38cqi)/1 var(--sans);
    margin: 6px 0 2px;
  }
  .clock.long {
    font-size: min(34px, 27cqi);
  }
  .held {
    color: var(--text-dim);
  }
</style>
