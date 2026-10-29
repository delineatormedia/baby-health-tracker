<script lang="ts">
  import type { Baby } from '@bht/schema';
  import { app } from './app.svelte.ts';

  /**
   * After joining a household (#5 step 3), this phone still has its own baby's entries. The
   * parent moves them into the household's baby, or keeps them on this phone only. Entries
   * that already reached another household can only be kept: they stay there.
   */
  let { own, to }: { own: Baby; to: Baby } = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);
  const count = $derived(app.events.length);
  const entries = $derived(`${count} ${count === 1 ? 'entry' : 'entries'}`);
  const synced = $derived(app.store.hasSynced(own.id));

  async function settle(move: boolean) {
    busy = true;
    error = null;
    try {
      await app.settleJoin(move);
    } catch (e) {
      console.error(e);
      error = 'Nothing changed. Try again.';
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen fade">
  <header class="top"><h1>Joined the household</h1></header>
  <p class="note">
    This phone has <b>{entries}</b> for {own.name}. The household's baby is <b>{to.name}</b>.
  </p>
  {#await synced then wasShared}
    {#if !wasShared}
      <button class="go2 primary" disabled={busy} onclick={() => settle(true)}>
        Move them into {to.name}
      </button>
      <p class="note">They are shared with the household. Remove duplicates in History.</p>
    {:else}
      <p class="note">They were shared with another household and stay there.</p>
    {/if}
    <button class="go2" disabled={busy} onclick={() => settle(false)}>
      Keep them off this household
    </button>
    <p class="note">They stay on this phone and are never uploaded.</p>
  {/await}
  {#if error}<p class="note err" role="alert">{error}</p>{/if}
</main>

<style>
  .note {
    margin: 10px 24px 16px;
    font-size: 15px;
    color: var(--text-dim);
  }
  .note b {
    color: var(--ink);
    font-weight: 500;
  }
  .top + .note {
    margin-top: 20px;
    font-size: 17px;
  }
  .primary {
    border: none;
    background: var(--acc);
    color: var(--acc-ink);
    font-weight: 600;
  }
  .err {
    color: var(--flag);
  }
</style>
