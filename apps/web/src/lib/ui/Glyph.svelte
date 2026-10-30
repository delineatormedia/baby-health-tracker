<script lang="ts" module>
  export type GlyphKind = 'feed' | 'bottle' | 'wet' | 'dirty' | 'pump';
</script>

<script lang="ts">
  /**
   * An event icon (#53): one colour, its kind's (currentColor), drawn on a 24 grid and centred
   * in the shared .g box, so the text after it lines up whichever kind it is (#50). Wet, Dirty
   * and Bottle are concept set A, Pump is set B and Feed is the parent–baby embrace, as the
   * owner picked.
   */
  let { kind }: { kind: GlyphKind } = $props();
</script>

<svg class="g g-{kind}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  {#if kind === 'feed'}
    <circle cx="8" cy="5.5" r="2.5" fill="currentColor" />
    <circle cx="15.5" cy="11" r="2.5" fill="currentColor" />
    <path
      d="M6 9C3 10 2 14 3 17c1 3 4 5 8 5h5c4 0 6-3 6-6h-3c0 2-1.5 3-3.5 3H11c-3 0-5-2-5-4 0-1 .5-2 1.5-2l3 3 2-2-4-4C8 9 7 9 6 9Z"
      fill="currentColor"
    />
    <path
      d="M12.5 17c0-2 1-3 3-3s3 1 3 3"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {:else}
    <g
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {#if kind === 'bottle'}
        <path
          d="M10 6V5a2 2 0 0 1 4 0v1M8 6h8v3H8ZM8 9l-1 3v7a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-7l-1-3M7 14h4M7 17h3"
        />
      {:else if kind === 'wet'}
        <path d="M12 3C10 6 5 11 5 14a7 7 0 0 0 14 0c0-3-5-8-7-11Z" />
      {:else if kind === 'dirty'}
        <path
          d="M3 5h18v4c0 7-4 12-9 12S3 16 3 9ZM3 9h18M3.5 12c4 0 6 3 6 8M20.5 12c-4 0-6 3-6 8"
        />
        <path d="M9.5 15h5v4.5l-2.5 1-2.5-1Z" fill="currentColor" stroke="none" />
      {:else}
        <path d="M3 3v12l8-4V7ZM11 9h5v3M12 12h9v6a3 3 0 0 1-3 3h-3a3 3 0 0 1-3-3Z" />
      {/if}
    </g>
  {/if}
</svg>
