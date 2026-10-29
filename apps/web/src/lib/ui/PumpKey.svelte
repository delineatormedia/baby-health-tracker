<script lang="ts">
  import LogKey from './LogKey.svelte';
  import { sideLine, type KeyLine } from './keys.ts';
  import { clock, pumpSide, type Pump } from './logic.ts';

  // The Pump key: idle, running (the live timer and its sides), or stopped with the amount
  // still to enter (#32). Every state opens /pump, where Stop and Log live.
  let {
    running,
    stopped,
    lines,
    now,
    onclick,
  }: {
    running: Pump | undefined;
    stopped: Pump | undefined;
    lines: readonly KeyLine[];
    now: number;
    onclick: () => void;
  } = $props();

  const timer = $derived(running ?? stopped);
  const side = $derived(timer ? sideLine(pumpSide(timer)) : null);
  const elapsed = $derived(running ? clock(now - Date.parse(running.occurredAt)) : '');
</script>

{#if running && side}
  <LogKey
    kind="pump"
    label="Pump"
    lines={[side]}
    running
    name="Pump running, {elapsed}, {side.em}{side.rest}"
    {onclick}
  >
    <span class="clock num" class:long={elapsed.length > 5}>{elapsed}</span>
    <small><em>{side.em}</em>{side.rest}</small>
  </LogKey>
{:else if stopped && side}
  <LogKey
    kind="pump"
    label="Pump"
    lines={[{ em: 'Add amount', rest: '' }, side]}
    running
    {onclick}
  />
{:else}
  <LogKey kind="pump" label="Pump" {lines} {onclick} />
{/if}

<style>
  /* Sized to the key, so the clock fits a 320 px screen, and smaller again past an hour. */
  .clock {
    font: 300 min(26px, 38cqi)/1 var(--sans);
    margin: 4px 0 0;
  }
  .clock.long {
    font-size: min(26px, 27cqi);
  }
</style>
