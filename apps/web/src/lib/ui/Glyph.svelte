<script lang="ts" module>
  export type GlyphKind = 'feed' | 'bottle' | 'wet' | 'dirty' | 'pump';
</script>

<script lang="ts">
  /**
   * An event icon (#53): one colour, its kind's (currentColor), drawn on a 24 grid and centred
   * in the shared .g box, so the text after it lines up whichever kind it is (#50). These are
   * today's shapes, scaled from the 12 px box, until the owner picks the icon set.
   */
  let { kind }: { kind: GlyphKind } = $props();
</script>

<svg class="g g-{kind}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  {#if kind === 'feed'}
    <rect x="8" y="2" width="8" height="20" rx="3.5" fill="currentColor" />
  {:else if kind === 'bottle'}
    <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="4" />
  {:else if kind === 'wet'}
    <circle cx="12" cy="12" r="10" fill="currentColor" />
  {:else if kind === 'dirty'}
    <rect x="3" y="3" width="18" height="18" fill="currentColor" />
  {:else}
    <path d="M12 1.5 22.5 12 12 22.5 1.5 12Z" fill="currentColor" />
  {/if}
</svg>
