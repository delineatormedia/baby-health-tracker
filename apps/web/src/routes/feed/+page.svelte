<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Side } from '@bht/schema';
  import { app, time } from '../../lib/ui/app.svelte.ts';
  import {
    ago,
    clock,
    currentSide,
    feedElapsed,
    finishFeedData,
    isPaused,
    lastSide,
    latestStart,
    MAX_FEED_SECONDS,
    minutes as mins,
    pauseFeedData,
    resumeFeedData,
    runningFeed,
    sideElapsed,
    sideTimes,
    startFeedData,
    suggestSide,
    switchFeedData,
    typedSide,
  } from '../../lib/ui/logic.ts';
  import TimeRow from '../../lib/ui/TimeRow.svelte';
  import Toast from '../../lib/ui/Toast.svelte';
  import { fromLocalInput, toLocalInput } from '../../lib/ui/time.ts';

  const running = $derived(runningFeed(app.events));
  const previous = $derived(lastSide(app.events));
  const next = $derived(suggestSide(app.events));
  const elapsed = $derived(running ? feedElapsed(running, app.now) : 0);
  const paused = $derived(running ? isPaused(running) : false);
  const on = $derived(running ? currentSide(running) : null);
  const onSide = $derived(running ? sideElapsed(running, app.now) : 0);
  const perSide = $derived(running ? sideTimes(running, app.now) : null);

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
  // A past feed's end; null is now.
  let endedAt = $state<string | null>(null);
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

  const BREASTS: ['left' | 'right', string][] = [
    ['left', 'Left'],
    ['right', 'Right'],
  ];
  const SIDES: [Side, string][] = [...BREASTS, ['both', 'Both']];

  /** Before a feed: start on that breast. During one: switch to it. */
  const tap = (side: 'left' | 'right') =>
    once(async () => {
      if (!running) {
        await app.log('breastfeed', startFeedData(side), `Breastfeed started · ${side}`);
        return;
      }
      if (on === side) {
        // Tapping the paused side resumes it.
        if (paused) await pauseOrResume();
        return;
      }
      // An old "both" timer has no side to switch from; the tap says which side it is.
      if (on === null) {
        await app.store.edit(running.id, { data: startFeedData(side) });
        return;
      }
      const data = switchFeedData(running, Date.now());
      if (data === null) return startTyping();
      const change = await app.store.edit(running.id, { data });
      app.showUndo(`Switched to ${side}`, change);
    });

  /** Pause or resume (#29). An edit like a switch, so Undo puts it back. */
  async function pauseOrResume() {
    if (!running) return;
    const now = Date.now();
    if (!paused) {
      const change = await app.store.edit(running.id, { data: pauseFeedData(running, now) });
      app.showUndo('Feed paused', change);
      return;
    }
    const data = resumeFeedData(running, now);
    if (data === null) return startTyping();
    const change = await app.store.edit(running.id, { data });
    app.showUndo('Feed resumed', change);
  }
  const togglePause = () => once(pauseOrResume);

  const stop = () =>
    once(async () => {
      if (!running) return;
      const data = finishFeedData(running, Date.now());
      if (data === null) return startTyping();
      const change = await app.store.edit(running.id, { data });
      app.showUndo(`Breastfeed · ${mins(data.durationSeconds ?? 0)} logged`, change);
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
    endedAt = null;
    // An overrun timer's elapsed time is not a duration, so there is nothing to prefill.
    minutes = running && !overrun ? Math.max(1, Math.round(elapsed / 60_000)) : null;
    typing = true;
  }

  /**
   * A typed duration replaces a running timer and ends now, or logs a past feed that ended at
   * `endedAt`. For an overrun timer the start time is what the parent knows, so the feed keeps it.
   * A typed duration has no per-side split, so it carries no segments.
   */
  const logTyped = () =>
    once(async () => {
      if (!validMinutes || minutes === null) return;
      const seconds = Math.round(minutes * 60);
      const data = { side: manualSide, durationSeconds: seconds };
      const label = `Breastfeed · ${Math.round(minutes)} min logged`;
      if (running) {
        const change = await app.store.edit(running.id, {
          data,
          occurredAt: overrun
            ? running.occurredAt
            : new Date(Date.now() - seconds * 1000).toISOString(),
        });
        app.showUndo(label, change);
      } else {
        const end = Math.min(endedAt === null ? Date.now() : Date.parse(endedAt), Date.now());
        await app.log('breastfeed', data, label, {
          occurredAt: new Date(end - seconds * 1000).toISOString(),
        });
      }
      await goto(resolve('/'), { replaceState: true });
    });

  async function moveStart(value: string) {
    const iso = fromLocalInput(value);
    if (!running || !iso) return;
    const ms = Date.parse(iso);
    const now = Date.now();
    if (ms > (latestStart(running, now) ?? now)) return;
    if (now - ms > MAX_FEED_SECONDS * 1000) return;
    try {
      await app.store.edit(running.id, { occurredAt: iso });
    } catch (e) {
      app.fail(e);
    }
  }
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
          max={toLocalInput(latestStart(running, app.now) ?? app.now)}
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
        >{running
          ? overrun
            ? `from ${time(running.occurredAt)}`
            : 'ending now'
          : 'past feed'}</span
      >
    </label>
    <div class="sides three">
      {#each SIDES as [side, label] (side)}
        <button aria-pressed={manualSide === side} onclick={() => (picked = side)}>
          {label}<small>{manualSide === side ? '●' : ''}</small>
        </button>
      {/each}
    </div>
    {#if !running}
      <TimeRow bind:at={endedAt} label="Ended" />
    {/if}
    <button class="go2" onclick={() => (typing = false)}
      >{running ? 'Back to the timer' : 'Back'}</button
    >
    <button class="go" disabled={!validMinutes} onclick={logTyped}>
      {validMinutes ? `Log ${Math.round(minutes ?? 0)} min` : 'Type the minutes'}
    </button>
  {:else}
    <div class="big">
      {#if running}
        <span class="lab">{paused ? 'Paused · ' : ''}{on ? `${on} side` : 'Both sides'}</span>
        <div class="v num" class:held={paused}>{clock(on ? onSide : elapsed)}</div>
        <span class="lab"
          >Total {clock(elapsed)} · {previous ? `last feed ${previous}` : 'first feed'}</span
        >
      {:else}
        <span class="lab">Start on</span>
        <div class="v num">{clock(0)}</div>
        <span class="lab">{previous ? `Last feed ${previous}` : 'First feed'}</span>
      {/if}
    </div>

    <div class="sides">
      {#each BREASTS as [side, label] (side)}
        <button aria-pressed={on === side} onclick={() => tap(side)}>
          {label}<small class="num"
            >{!running
              ? side === next
                ? 'Start · next'
                : 'Start'
              : on === side
                ? paused
                  ? 'Resume'
                  : clock(perSide?.[side] ?? 0)
                : on === null
                  ? 'This side'
                  : `Switch${perSide?.[side] ? ` · ${clock(perSide[side])}` : ''}`}</small
          >
        </button>
      {/each}
    </div>
    <div class="toast"><Toast /></div>

    {#if running}
      <button class="go2 pause" aria-pressed={paused} onclick={togglePause}
        >{paused ? 'Resume' : 'Pause'}</button
      >
      <button class="go2" onclick={startTyping}>Type a duration instead</button>
      <button class="go" onclick={stop}
        >{overrun ? 'Stop · set the duration' : `Stop · log ${mins(elapsed / 1000)}`}</button
      >
    {:else}
      <button class="go2" onclick={startTyping}>Log a past feed</button>
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
  .held {
    color: var(--dim);
  }
  .pause {
    margin-top: 10px;
    margin-bottom: 10px;
  }
  .pause[aria-pressed='true'] {
    background: var(--ink);
    color: var(--bg);
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
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin: 7vh 16px 18px;
  }
  .sides.three {
    grid-template-columns: repeat(3, 1fr);
    margin-top: 4vh;
  }
  .toast {
    margin: 0 16px;
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
    font: 400 15px var(--mono);
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
