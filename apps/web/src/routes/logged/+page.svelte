<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { app } from '../../lib/ui/app.svelte.ts';
  import { cappedStart, describe, kindName, latestStart } from '../../lib/ui/logic.ts';
  import TimeRow from '../../lib/ui/TimeRow.svelte';
  import { when } from '../../lib/ui/time.ts';

  // Wet's detail screen, opened from the Logged toast; bottles and finished feeds share it.
  const id = page.url.searchParams.get('id') ?? '';
  const event = $derived(app.events.find((e) => e.id === id));
  const feed = $derived(event?.type === 'breastfeed');

  let at = $state<string | null>(untrack(() => event?.occurredAt ?? null));
  // The parent came here to change the time, so the choices are already showing.
  let open = $state(true);
  let busy = false;

  async function done() {
    if (busy || !event) return;
    busy = true;
    try {
      // The row already honours the cap; the clock has moved since, so hold it exactly here too.
      const occurredAt = cappedStart(event, at, Date.now());
      if (occurredAt !== event.occurredAt) {
        const change = await app.store.edit(event.id, { occurredAt });
        app.showUndo(`${kindName(event)} moved · ${when(occurredAt, Date.now())}`, change);
      }
      await goto(resolve('/'), { replaceState: true });
    } catch (e) {
      app.fail(e);
    } finally {
      busy = false;
    }
  }

  async function undo() {
    if (busy || !event) return;
    busy = true;
    try {
      await app.store.remove(event.id);
      await goto(resolve('/'), { replaceState: true });
    } catch (e) {
      app.fail(e);
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen fade">
  <header class="top">
    <h1>Details</h1>
    <span class="lab">Optional</span>
  </header>

  {#if event}
    <div class="done">
      <div>Logged · {describe(event, app.volume).toLowerCase()}</div>
      <button onclick={undo}>Undo</button>
    </div>
    <TimeRow
      bind:at
      bind:open
      label={feed ? 'Started' : 'Time'}
      latest={latestStart(event, app.now)}
    />
    <button class="go" onclick={done}>Done</button>
  {:else}
    <p class="gone">This entry is no longer in the log.</p>
    <a class="go back" href={resolve('/')}>Home</a>
  {/if}
</main>

<style>
  .done {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 18px 16px 0;
    padding: 6px 0 6px 16px;
    min-height: 58px;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .done div {
    flex: 1;
    font-size: 15px;
  }
  .done button {
    align-self: stretch;
    padding: 0 16px;
    font-weight: 600;
    font-size: 15px;
  }
  .gone {
    margin: 32px 24px;
    color: var(--dim);
  }
  .back {
    display: flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
  }
</style>
