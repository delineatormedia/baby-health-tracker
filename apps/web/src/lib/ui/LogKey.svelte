<script lang="ts">
  import type { Snippet } from 'svelte';
  import { keyName, type KeyKind, type KeyLine } from './keys.ts';
  import Glyph from './Glyph.svelte';

  // One Home quick-log key (#20): a 2 px outline in the event colour, the label with the event's
  // shape, and its last-logged lines. Running, it gets a 3 px outline, the 16% tint, and
  // `children` in place of the lines. Paused, the outline turns dashed and the tint goes.
  let {
    kind,
    label,
    lines,
    onclick,
    tall = false,
    running = false,
    paused = false,
    name,
    children,
  }: {
    kind: KeyKind;
    label: string;
    lines: readonly KeyLine[];
    onclick: () => void;
    tall?: boolean;
    running?: boolean;
    paused?: boolean;
    /** Accessible name; defaults to the label and lines. */
    name?: string;
    children?: Snippet;
  } = $props();

  /** Lines wrap between phrases, never inside "1h 19m", "60 mL" or "1:40 AM". */
  const glue = (s: string) =>
    s.replace(/(\d\S*) (?=\d)/g, '$1\u00a0').replace(/(\d) (?=[a-zA-Z])/g, '$1\u00a0');
</script>

<button
  class="key"
  class:tall
  class:run={running}
  class:paused
  style:--ev="var(--{kind})"
  aria-label={name ?? keyName(label, lines)}
  {onclick}
>
  <b><Glyph {kind} />{label}</b>
  {#if children}
    {@render children()}
  {:else}
    {#each lines as l, i (i)}
      <small class="num"
        >{#if l.em}<em>{glue(l.em)}</em>{/if}{glue(l.rest)}</small
      >
    {/each}
  {/if}
</button>

<style>
  .key {
    min-width: 0;
    /* The live clocks size themselves to the key (cqi). */
    container-type: inline-size;
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
  /* Narrow keys (320 px screens) put the 16 px icon on its own line above the label, so the
     label gets the whole key width whatever font the phone falls back to (#53). */
  b {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    font-weight: 600;
  }
  /* The icon is 20 px beside the label once the key fits "Bottle" next to it (from 375 px
     screens). */
  @container (min-width: 83px) {
    b {
      flex-direction: row;
      align-items: center;
      gap: 8px;
    }
    b :global(.g) {
      --g: 20px;
    }
  }
  small,
  .key :global(small) {
    max-width: 100%;
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
  .run.paused {
    border-style: dashed;
    background: var(--panel);
  }
  .run :global(small) {
    color: var(--ink);
  }
</style>
