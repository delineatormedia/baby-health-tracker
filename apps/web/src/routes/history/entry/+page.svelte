<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { app } from '../../../lib/ui/app.svelte.ts';
  import { rowText } from '../../../lib/ui/history.ts';
  import { cappedStart, isLogMark, kindName, latestStart } from '../../../lib/ui/logic.ts';
  import TimeRow from '../../../lib/ui/TimeRow.svelte';
  import { when } from '../../../lib/ui/time.ts';

  // Opened from a History row. Every change is a new version, so Undo and the history hold.
  const id = page.url.searchParams.get('id') ?? '';
  const event = $derived(app.events.find((e) => e.id === id && !isLogMark(e)));
  const text = $derived(event && !isLogMark(event) ? rowText(event, app.volume) : null);
  const stool = $derived(event?.type === 'diaper' && event.data.kind !== 'wet');

  let at = $state<string | null>(untrack(() => event?.occurredAt ?? null));
  let open = $state(false);
  let busy = false;

  const back = () => goto(resolve('/history'), { replaceState: true });

  async function save() {
    if (busy || !event) return;
    busy = true;
    try {
      const occurredAt = cappedStart(event, at, Date.now());
      if (occurredAt !== event.occurredAt) {
        const change = await app.store.edit(event.id, { occurredAt });
        app.showUndo(`${kindName(event)} moved · ${when(occurredAt, Date.now())}`, change);
      }
      await back();
    } catch (e) {
      app.fail(e);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (busy || !event) return;
    busy = true;
    try {
      const change = await app.store.remove(event.id);
      app.showUndo(`${kindName(event)} deleted`, change);
      await back();
    } catch (e) {
      app.fail(e);
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen fade">
  <header class="top">
    <a class="back" href={resolve('/history')}>‹ History</a>
  </header>

  {#if event && text}
    <section class="what">
      <h1>{text.title}</h1>
      {#if text.caption}<p>{text.caption}</p>{/if}
    </section>
    <TimeRow
      bind:at
      bind:open
      label={event.type === 'breastfeed' ? 'Started' : 'Time'}
      latest={latestStart(event, app.now)}
    />
    {#if stool}
      <a class="go2 more" href={resolve(`/diaper/details?id=${event.id}`)}>Stool details ›</a>
    {/if}
    <button class="go2 del" onclick={remove}>Delete</button>
    <button class="go" onclick={save}>Save</button>
  {:else}
    <p class="gone">This entry is no longer in the log.</p>
    <a class="go home" href={resolve('/history')}>History</a>
  {/if}
</main>

<style>
  .what {
    margin: 18px 24px 0;
  }
  .what h1 {
    font: 600 24px var(--sans);
  }
  .what p {
    margin-top: 4px;
    font-size: 15px;
    color: var(--text-dim);
  }
  .go2 {
    margin-top: 16px;
    font-size: 20px;
    background: var(--panel);
  }
  .more {
    display: flex;
    align-items: center;
    justify-content: center;
    color: inherit;
    text-decoration: none;
  }
  .gone {
    margin: 32px 24px;
    font-size: 17px;
    color: var(--text-dim);
  }
  .home {
    display: flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
  }
</style>
