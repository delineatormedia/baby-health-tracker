<script lang="ts">
  import LogKey from './LogKey.svelte';
  import { sideLine, type KeyLine } from './keys.ts';
  import { clock, currentSide, type Breastfeed } from './logic.ts';

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

  const elapsed = $derived(running ? clock(now - Date.parse(running.occurredAt)) : '');
  const side = $derived(running ? sideLine(currentSide(running) ?? running.data.side) : null);
</script>

{#if running && side}
  <LogKey
    kind="feed"
    label="Stop"
    lines={[side]}
    tall
    running
    name="Stop the breastfeed, {elapsed}, {side.em}{side.rest}"
    onclick={onstop}
  >
    <span class="clock num">{elapsed}</span>
    <small><em>{side.em}</em>{side.rest}</small>
  </LogKey>
{:else}
  <LogKey kind="feed" label="Feed" {lines} tall onclick={onstart} />
{/if}

<style>
  .clock {
    font: 300 34px/1 var(--sans);
    margin: 6px 0 2px;
  }
</style>
