<script lang="ts">
  import type { Snippet } from 'svelte';
  import { keyName, type KeyKind, type KeyLine } from './keys.ts';

  // One Home quick-log key (#20): a 2 px outline in the event colour, the label with the event's
  // shape, and its last-logged lines. Running, it gets a 3 px outline, the 16% tint, and
  // `children` in place of the lines.
  let {
    kind,
    label,
    lines,
    onclick,
    tall = false,
    running = false,
    disabled = false,
    name,
    children,
  }: {
    kind: KeyKind;
    label: string;
    lines: readonly KeyLine[];
    onclick: () => void;
    tall?: boolean;
    running?: boolean;
    disabled?: boolean;
    /** Accessible name; defaults to the label and lines. */
    name?: string;
    children?: Snippet;
  } = $props();
</script>

<button
  class="key"
  class:tall
  class:run={running}
  style:--ev="var(--{kind})"
  aria-label={name ?? keyName(label, lines)}
  {disabled}
  {onclick}
>
  <b><i class="g g-{kind}" aria-hidden="true"></i>{label}</b>
  {#if children}
    {@render children()}
  {:else}
    {#each lines as l, i (i)}
      <small class="num"
        >{#if l.em}<em>{l.em}</em>{/if}{l.rest}</small
      >
    {/each}
  {/if}
</button>

<style>
  .key {
    min-width: 0;
    border-radius: 16px;
    background: var(--panel);
    border: 2px solid var(--ev);
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: flex-start;
    padding: 10px 12px;
    font: 600 20px/1.1 var(--sans);
    color: var(--ink);
    text-align: left;
  }
  .key:active {
    transform: scale(0.97);
  }
  .tall {
    grid-row: span 2;
  }
  b {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  small,
  .key :global(small) {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 400 15px/1.25 var(--sans);
    color: var(--text-dim);
    margin-top: 4px;
  }
  em,
  .key :global(em) {
    font-style: normal;
    color: var(--ink);
  }
  .run {
    border-width: 3px;
    background: color-mix(in srgb, var(--ev) 16%, var(--panel));
  }
  .run :global(small) {
    color: var(--ink);
  }
  /* Event shapes, the same as the dial and History: feed bar, bottle ring, wet dot, dirty
     square, pump diamond. */
  .g {
    display: inline-block;
    width: 12px;
    height: 12px;
    flex: none;
  }
  .g-feed {
    background: var(--feed);
    border-radius: 2px;
    width: 6px;
    height: 14px;
  }
  .g-bottle {
    border: 2.5px solid var(--bottle);
    border-radius: 50%;
  }
  .g-wet {
    background: var(--wet);
    border-radius: 50%;
  }
  .g-dirty {
    background: var(--dirty);
  }
  .g-pump {
    background: var(--pump);
    transform: rotate(45deg) scale(0.85);
  }
</style>
