<script lang="ts">
  import { app } from './app.svelte.ts';
</script>

<!-- #42: in a Safari tab, iPhone can delete the logs after 7 days without a visit. -->
{#if app.showHomeNote}
  <aside class="home-note" aria-label="Keep your logs">
    <p>
      <b>Add to Home Screen to keep your logs on this phone.</b>
      In a Safari tab, iPhone can clear them after 7 days without a visit. Tap Share, then Add to Home
      Screen.
    </p>
    <button onclick={() => app.dismissHomeNote()}>Dismiss</button>
  </aside>
{/if}

<style>
  .home-note {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin: 14px 16px 0;
    padding: 12px 0 12px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
  }
  .home-note p {
    flex: 1;
    font-size: 15px;
    color: var(--text-dim);
  }
  .home-note b {
    display: block;
    margin-bottom: 4px;
    color: var(--ink);
    font-weight: 500;
  }
  .home-note button {
    flex: none;
    min-height: 44px;
    padding: 0 16px;
    font: 600 15px var(--sans);
    color: var(--ink);
  }
</style>
