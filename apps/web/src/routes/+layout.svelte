<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';
  import { app } from '../lib/ui/app.svelte.ts';
  import Setup from '../lib/ui/Setup.svelte';

  let { children }: { children: Snippet } = $props();

  void app.init();

  $effect(() => {
    document.documentElement.dataset.theme = app.prefs.theme;
  });
</script>

{#if app.error}
  <main class="screen fail">
    <h1>This phone can't open the log</h1>
    <p>{app.error}</p>
    <p>Private browsing can block local storage. Open the app normally and try again.</p>
  </main>
{:else if app.ready && !app.baby}
  <Setup />
{:else if app.ready}
  {@render children()}
{/if}

<style>
  .fail {
    padding: 48px 24px;
  }
  .fail h1 {
    font: 600 22px var(--sans);
    margin-bottom: 12px;
  }
  .fail p {
    color: var(--dim);
    margin-bottom: 10px;
  }
</style>
