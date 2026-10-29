<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';
  import { app } from '../lib/ui/app.svelte.ts';
  import JoinChoice from '../lib/ui/JoinChoice.svelte';
  import Setup from '../lib/ui/Setup.svelte';

  let { children }: { children: Snippet } = $props();

  void app.init();

  $effect(() => {
    document.documentElement.dataset.theme = app.prefs.theme;
  });
</script>

{#if app.saveError}
  <div class="save-fail" role="alert">
    <span>{app.saveError?.text}</span>
    <span class="acts">
      {#if app.saveError?.retry}
        <button onclick={() => app.retrySave()}>{app.saveError?.retry?.label}</button>
      {/if}
      <button onclick={() => (app.saveError = null)}
        >{app.saveError?.retry ? 'Dismiss' : 'OK'}</button
      >
    </span>
  </div>
{/if}

{#if app.error}
  <main class="screen fail">
    <h1>This phone can't open the log</h1>
    <p>{app.error}</p>
    <p>Private browsing can block local storage. Open the app normally and try again.</p>
  </main>
{:else if app.ready && !app.baby}
  <Setup />
{:else if app.ready && app.baby && app.joining}
  <JoinChoice own={app.baby} to={app.joining} />
{:else if app.ready}
  {@render children()}
{/if}

<style>
  .save-fail {
    position: fixed;
    top: calc(8px + env(safe-area-inset-top));
    left: 12px;
    right: 12px;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 52px;
    padding-left: 14px;
    border: 2px solid var(--flag);
    border-radius: 12px;
    background: var(--panel);
    font-size: 14px;
  }
  .save-fail .acts {
    display: flex;
    align-self: stretch;
  }
  .save-fail button {
    align-self: stretch;
    padding: 0 16px;
    font-weight: 600;
  }
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
