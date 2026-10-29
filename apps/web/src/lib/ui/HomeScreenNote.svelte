<script lang="ts">
  import { resolve } from '$app/paths';
  import { app } from './app.svelte.ts';

  /** Home keeps it to one row so the dial stays in view; Settings explains why. */
  let { compact = false }: { compact?: boolean } = $props();
</script>

<!-- #42: in a Safari tab, iPhone can delete the logs after 7 days without a visit. -->
{#if app.showHomeNote}
  {#if compact}
    <aside class="home-note row" aria-label="Keep your logs">
      <!-- The whole message is the "How" link: a separate word doesn't fit at 20 px. -->
      <a href="{resolve('/settings')}#storage"
        ><span class="msg">Keep logs on this phone</span><span aria-hidden="true">›</span><span
          class="sr">, how</span
        ></a
      >
      <button aria-label="Dismiss" onclick={() => app.dismissHomeNote()}>✕</button>
    </aside>
  {:else}
    <aside class="home-note" aria-label="Keep your logs">
      <p>
        <b>Add to Home Screen to keep your logs on this phone.</b>
        In a Safari tab, iPhone can clear them after 7 days without a visit. Tap Share, then Add to Home
        Screen.
      </p>
      <button onclick={() => app.dismissHomeNote()}>Dismiss</button>
    </aside>
  {/if}
{/if}

<style>
  .home-note {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 12px;
    margin: 14px 16px 0;
    padding: 12px 0 12px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
  }
  /* On a narrow phone Dismiss goes under the text instead of squeezing it. */
  .home-note p {
    flex: 1 1 200px;
    font-size: 17px;
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
    font: 600 20px var(--sans);
    color: var(--ink);
  }
  /* The border sits outside the 44 px hit targets, so the row is 46 px. */
  .row {
    flex-wrap: nowrap;
    align-items: stretch;
    gap: 0;
    margin: 10px 12px 0;
    padding: 0 0 0 14px;
    font-size: 20px;
  }
  .row .msg {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
  }
  .row a {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding-left: 14px;
    margin-left: -14px;
    font-weight: 500;
    color: var(--ink);
    text-decoration: none;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .row button {
    min-height: 44px;
    width: 44px;
    padding: 0;
    font-size: 20px;
    color: var(--text-dim);
  }
</style>
