<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Side } from '@bht/schema';
  import { app, time } from '../../lib/ui/app.svelte.ts';
  import {
    ago,
    clock,
    lastSide,
    MAX_FEED_SECONDS,
    runningFeed,
    stopSeconds,
    typedSide,
  } from '../../lib/ui/logic.ts';
  import { fromLocalInput, toLocalInput } from '../../lib/ui/time.ts';

  const running = $derived(runningFeed(app.events));
  const previous = $derived(lastSide(app.events));
  const elapsed = $derived(running ? app.now - Date.parse(running.occurredAt) : 0);

  /**
   * A timer past the schema's 4-hour bound was almost certainly left running. Nothing is saved
   * until the parent types the real duration; the timer keeps running until then.
   */
  const overrun = $derived(elapsed > MAX_FEED_SECONDS * 1000);

  // Home sends ?fix when Stop found an overrun timer.
  let typing = $state(page.url.searchParams.has('fix'));
  let minutes = $state<number | null>(null);
  // Follows the log until the parent picks a side, so a direct load of ?fix keeps the running side.
  let picked = $state<Side | null>(null);
  const manualSide = $derived(picked ?? typedSide(app.events));
  let busy = false;

  async function once(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      app.fail(e);
    } finally {
      busy = false;
    }
  }

  const SIDES: [Side, string][] = [
    ['left', 'Left'],
    ['right', 'Right'],
    ['both', 'Both'],
  ];

  /** Before a feed: start on that side. During one: correct the side. */
  const choose = (side: Side) =>
    once(async () => {
      if (typing) {
        picked = side;
      } else if (!running) {
        await app.log('breastfeed', { side, durationSeconds: null }, 'Breastfeed started');
      } else if (running.data.side !== side) {
        await app.store.edit(running.id, { data: { ...running.data, side } });
      }
    });

  const stop = () =>
    once(async () => {
      if (!running) return;
      const seconds = stopSeconds(running.occurredAt, Date.now());
      if (seconds === null) return startTyping();
      const change = await app.store.edit(running.id, {
        data: { ...running.data, durationSeconds: seconds },
      });
      app.showUndo(`Breastfeed · ${Math.max(1, Math.round(seconds / 60))} min logged`, change);
      await goto(resolve('/'), { replaceState: true });
    });

  const validMinutes = $derived(
    minutes !== null &&
      Number.isFinite(minutes) &&
      minutes >= 1 &&
      minutes * 60 <= MAX_FEED_SECONDS,
  );

  function startTyping() {
    picked = null;
    // An overrun timer's elapsed time is not a duration, so there is nothing to prefill.
    minutes = running && !overrun ? Math.max(1, Math.round(elapsed / 60_000)) : null;
    typing = true;
  }

  /**
   * A typed duration ends now: it replaces a running timer, or logs a feed that just finished.
   * For an overrun timer the start time is what the parent knows, so the feed keeps it.
   */
  const logTyped = () =>
    once(async () => {
      if (!validMinutes || minutes === null) return;
      const seconds = Math.round(minutes * 60);
      if (running) {
        const change = await app.store.edit(running.id, {
          data: { side: manualSide, durationSeconds: seconds },
          occurredAt: overrun
            ? running.occurredAt
            : new Date(Date.now() - seconds * 1000).toISOString(),
        });
        app.showUndo(`Breastfeed · ${Math.round(minutes)} min logged`, change);
      } else {
        await app.log(
          'breastfeed',
          { side: manualSide, durationSeconds: seconds },
          `Breastfeed · ${Math.round(minutes)} min logged`,
          {
            occurredAt: new Date(Date.now() - seconds * 1000).toISOString(),
          },
        );
      }
      await goto(resolve('/'), { replaceState: true });
    });

  async function moveStart(value: string) {
    const iso = fromLocalInput(value);
    if (!running || !iso || Date.parse(iso) > Date.now()) return;
    if (Date.now() - Date.parse(iso) > MAX_FEED_SECONDS * 1000) return;
    try {
      await app.store.edit(running.id, { occurredAt: iso });
    } catch (e) {
      app.fail(e);
    }
  }

  const current = $derived(typing ? manualSide : running?.data.side);
</script>

<main class="screen fade">
  <header class="top">
    <h1>Breastfeed</h1>
    {#if running}
      <label class="lab when">
        Started {time(running.occurredAt)} ›
        <input
          type="datetime-local"
          value={toLocalInput(Date.parse(running.occurredAt))}
          max={toLocalInput(app.now)}
          onchange={(e) => void moveStart(e.currentTarget.value)}
          aria-label="Change the start time"
        />
      </label>
    {/if}
  </header>

  {#if typing && running && overrun}
    <p class="overrun" role="status">
      Timer ran {ago(elapsed)}. How long was the feed?
    </p>
  {/if}

  {#if typing}
    <label class="typed">
      <span class="lab">Minutes</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="number" inputmode="numeric" min="1" max="240" bind:value={minutes} autofocus />
      <span class="lab"
        >{running && overrun ? `from ${time(running.occurredAt)}` : 'ending now'}</span
      >
    </label>
  {:else}
    <div class="big">
      <span class="lab">{running ? `${running.data.side} side` : 'Not started'}</span>
      <div class="v num">{clock(elapsed)}</div>
      <span class="lab">{previous ? `Last feed ${previous}` : 'First feed'}</span>
    </div>
  {/if}

  <div class="sides">
    {#each SIDES as [side, label] (side)}
      <button aria-pressed={current === side} onclick={() => choose(side)}>
        {label}<small>{!typing && !running ? 'Start' : current === side ? '●' : ''}</small>
      </button>
    {/each}
  </div>

  {#if typing}
    <button class="go2" onclick={() => (typing = false)}>Back to the timer</button>
    <button class="go" disabled={!validMinutes} onclick={logTyped}>
      {validMinutes ? `Log ${Math.round(minutes ?? 0)} min` : 'Type the minutes'}
    </button>
  {:else}
    <button class="go2" onclick={startTyping}>Type a duration instead</button>
    {#if running}
      <button class="go" onclick={stop}
        >{overrun
          ? 'Stop · set the duration'
          : `Stop · log ${Math.max(1, Math.round(elapsed / 60_000))} min`}</button
      >
    {:else}
      <a class="go link" href={resolve('/')}>Home</a>
    {/if}
  {/if}
</main>

<style>
  .screen {
    padding-bottom: calc(110px + var(--safe-b));
  }
  .when {
    position: relative;
    padding: 8px 0;
  }
  .when input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
  }
  .big {
    text-align: center;
    margin-top: 9vh;
  }
  .big .v {
    font: 200 clamp(72px, 24vw, 96px) / 1 var(--sans);
    letter-spacing: -0.03em;
    margin: 12px 0;
  }
  .overrun {
    margin: 6vh 24px 0;
    text-align: center;
    font: 600 18px var(--sans);
  }
  .typed {
    display: block;
    text-align: center;
    margin-top: 9vh;
  }
  .typed input {
    display: block;
    width: 3.2em;
    margin: 8px auto;
    text-align: center;
    border: none;
    border-bottom: 2px solid var(--line);
    background: none;
    font: 200 72px/1.1 var(--sans);
    outline: none;
  }
  .sides {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin: 7vh 16px 18px;
  }
  .sides button {
    height: 110px;
    border-radius: 18px;
    border: 1px solid var(--line);
    background: var(--panel);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font: 600 20px var(--sans);
  }
  .sides button[aria-pressed='true'] {
    border: 2px solid var(--acc);
  }
  .sides small {
    font: 400 12px var(--mono);
    color: var(--dim);
    min-height: 1em;
    text-transform: uppercase;
  }
  .link {
    display: flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
  }
</style>
