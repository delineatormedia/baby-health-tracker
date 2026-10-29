<script lang="ts">
  import { app } from './app.svelte.ts';
  import { ago } from './logic.ts';
  import { minutesBefore, QUICK_OFFSETS, readPick, toLocalInput, when } from './time.ts';

  /**
   * The one time control on every logging screen (#18). `at` is a UTC timestamp, or null for
   * "now" at the moment of saving. `latest` caps it exactly, e.g. a finished feed must start
   * early enough to have ended by now; "Now" and any offset after the cap are disabled.
   */
  let {
    at = $bindable(null),
    label = 'Time',
    latest,
    open = $bindable(false),
  }: { at?: string | null; label?: string; latest?: number; open?: boolean } = $props();

  const cap = $derived(latest ?? app.now);
  const nowAllowed = $derived(cap >= app.now);
  const value = $derived(
    at === null ? 'Now' : `${when(at, app.now)} · ${agoText(app.now - Date.parse(at))}`,
  );

  function agoText(ms: number): string {
    const a = ago(ms);
    return a === 'just now' ? a : `${a} ago`;
  }

  function set(next: string | null) {
    at = next;
    open = false;
  }
</script>

<section class="trow" class:open>
  <button class="row" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="lab">{label}</span>
    <span class="val num">{value}</span>
    <span class="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
  </button>
  {#if open}
    <div class="quick">
      <button aria-pressed={at === null} disabled={!nowAllowed} onclick={() => set(null)}
        >Now</button
      >
      {#each QUICK_OFFSETS as m (m)}
        {@const t = minutesBefore(app.now, m)}
        <button disabled={Date.parse(t) > cap} onclick={() => set(t)}
          >−{m < 60 ? `${m} min` : `${m / 60} h`}</button
        >
      {/each}
      <!-- A transparent native picker over the button: one tap opens the phone's own wheel. -->
      <label class="pick">
        Other time ›
        <input
          type="datetime-local"
          value={toLocalInput(at === null ? app.now : Date.parse(at))}
          max={toLocalInput(cap)}
          onchange={(e) => {
            const next = readPick(e.currentTarget.value, Date.now(), latest);
            if (next !== undefined) set(next);
          }}
          aria-label="Pick a time"
        />
      </label>
    </div>
  {/if}
</section>

<style>
  .trow {
    margin: 16px 16px 0;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .trow.open {
    border-color: var(--ink);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 0 16px;
    text-align: left;
  }
  .val {
    flex: 1;
    font: 600 20px var(--sans);
    text-align: right;
  }
  .chev {
    color: var(--dim);
    width: 1em;
    font-size: 20px;
  }
  .quick {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    padding: 0 12px 12px;
  }
  .quick button,
  .pick {
    min-height: 52px;
    border-radius: 12px;
    border: 1px solid var(--line);
    font-size: 20px;
  }
  .quick button[aria-pressed='true'] {
    border: 2px solid var(--ink);
    font-weight: 600;
  }
  .pick {
    grid-column: 1 / -1;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .pick input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
  }
</style>
