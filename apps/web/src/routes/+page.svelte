<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { app, time } from '../lib/ui/app.svelte.ts';
  import Dial from '../lib/ui/Dial.svelte';
  import FeedKey from '../lib/ui/FeedKey.svelte';
  import LogKey from '../lib/ui/LogKey.svelte';
  import PumpKey from '../lib/ui/PumpKey.svelte';
  import { keyLines } from '../lib/ui/keys.ts';
  import Toast from '../lib/ui/Toast.svelte';
  import {
    ageDays,
    clock,
    countMarks,
    currentSide,
    dayMarks,
    feedElapsed,
    finishFeedData,
    hm,
    isPaused,
    minutes,
    runningFeed,
    runningPump,
    stoppedPump,
  } from '../lib/ui/logic.ts';

  const baby = $derived(app.baby!);
  const marks = $derived(dayMarks(app.events, app.now));
  const counts = $derived(countMarks(marks));
  const running = $derived(runningFeed(app.events));
  const lastFeed = $derived(app.events.find((e) => e.type === 'breastfeed' || e.type === 'bottle'));
  const pumping = $derived(runningPump(app.events));
  const pumpStopped = $derived(pumping ? undefined : stoppedPump(app.events));
  const lines = $derived(keyLines(app.events, app.now, app.volume));

  let busy = $state(false);
  let dockHeight = $state(300);

  /** Serialises taps so a double tap cannot log twice. */
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

  const stopFeed = () =>
    once(async () => {
      if (!running) return;
      const data = finishFeedData(running, Date.now());
      // Past the 4-hour bound: save nothing, ask how long the feed really was.
      if (data === null) return goto(resolve('/feed?fix'));
      const change = await app.store.edit(running.id, { data });
      app.showUndo(`Breastfeed · ${minutes(data.durationSeconds ?? 0)} logged`, change);
    });

  const wet = () => once(() => app.log('diaper', { kind: 'wet' }, 'Wet logged'));
</script>

<!-- The page scrolls clear of the dock, however tall wrapped key lines make it. -->
<main class="screen fade" style:--dock-h="{dockHeight}px">
  <header class="top">
    <span class="title-row">
      <h1>{baby.name}</h1>
      <span class="lab num age">{ageDays(baby.birthAt, app.now)} days · last 24 h</span>
    </span>
    <!-- The #20 board has no place for Settings; it left the chip row for Weight and History. -->
    <a class="act" href={resolve('/settings')}>Settings</a>
  </header>

  <!-- The dial is the last 24 hours, so tapping it opens Reports (#21). While a feed runs it
       stays the way back to the timer, where the parent switches sides. -->
  <a
    href={running ? resolve('/feed') : resolve('/reports')}
    class="dial-link"
    aria-label={running ? 'Open the breastfeed timer' : 'Open Reports'}
  >
    <Dial {marks} running={running?.occurredAt ?? null} now={app.now}>
      {#if running}
        <span class="lab"
          >{isPaused(running) ? 'Paused' : 'Feeding'} · {currentSide(running) ??
            running.data.side}</span
        >
        <span class="v num" class:held={isPaused(running)}
          >{clock(feedElapsed(running, app.now))}</span
        >
        <span class="lab"
          >{isPaused(running) && running.data.pausedAt
            ? `paused at ${time(running.data.pausedAt)}`
            : `since ${time(running.occurredAt)}`}</span
        >
      {:else if lastFeed}
        <span class="lab">Last feed</span>
        <span class="v num">{hm(app.now - Date.parse(lastFeed.occurredAt))}</span>
        <span class="lab">h:mm ago · {time(lastFeed.occurredAt)}</span>
      {:else}
        <span class="lab">No feeds yet</span>
      {/if}
    </Dial>
  </a>

  <div class="legend">
    <span><i class="g g-feed"></i>Feed <b class="num">{counts.feed}</b></span>
    <span><i class="g g-bottle"></i>Bottle <b class="num">{counts.bottle}</b></span>
    <span><i class="g g-wet"></i>Wet <b class="num">{counts.wet}</b></span>
    <span><i class="g g-dirty"></i>Dirty <b class="num">{counts.dirty}</b></span>
  </div>
  <p class="quiet lab">Saved on this phone · not synced</p>

  <div class="dock" bind:clientHeight={dockHeight}>
    <Toast />
    <nav class="chips">
      <a href={resolve('/weight')}>Weight</a>
      <a href={resolve('/history')}>History</a>
      <a href={resolve('/readings')}>Readings</a>
    </nav>
    <div class="rail">
      <!-- Feed opens Left / Right: starting on either side is two taps (#19). -->
      <FeedKey
        {running}
        lines={lines.feed}
        now={app.now}
        onstart={() => goto(resolve('/feed'))}
        onstop={stopFeed}
      />
      <LogKey kind="wet" label="Wet" lines={lines.wet} onclick={wet} />
      <LogKey
        kind="dirty"
        label="Dirty"
        lines={lines.dirty}
        onclick={() => goto(resolve('/diaper'))}
      />
      <LogKey
        kind="bottle"
        label="Bottle"
        lines={lines.bottle}
        onclick={() => goto(resolve('/bottle'))}
      />
      <PumpKey
        running={pumping}
        stopped={pumpStopped}
        lines={lines.pump}
        now={app.now}
        onclick={() => goto(resolve('/pump'))}
      />
    </div>
  </div>
</main>

<style>
  .screen {
    padding-bottom: calc(var(--dock-h) + 16px);
  }
  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 12px;
    min-width: 0;
  }
  .act {
    flex: none;
    /* A 44 px tap height without moving the header. */
    padding: 10px 0;
    margin: -10px 0;
    font: 500 20px var(--sans);
    color: var(--ink);
    text-decoration: none;
  }
  .dial-link {
    display: block;
    color: inherit;
    text-decoration: none;
  }
  .v {
    font: 300 clamp(44px, 15vw, 60px) / 1 var(--sans);
    letter-spacing: -0.02em;
    margin: 8px 0;
  }
  .held {
    color: var(--text-dim);
  }
  /* Home captions at the README floor: 15 px and --text-dim, which reaches 4.5:1 where the
     shared 11 px --dim .lab does not. Shared tokens move in #38. */
  .lab {
    font-size: 15px;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px 18px;
    margin-top: 14px;
    font: 400 15px var(--sans);
    color: var(--text-dim);
  }
  .legend span {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .legend b {
    color: var(--ink);
    font-weight: 600;
  }
  .age {
    white-space: nowrap;
  }
  .quiet {
    text-align: center;
    margin-top: 8px;
  }
  .dock {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    max-width: 480px;
    margin: 0 auto;
    padding: 0 12px calc(16px + var(--safe-b));
    background: linear-gradient(transparent, var(--bg) 24px);
  }
  .chips {
    display: flex;
    gap: 6px;
    margin: 10px 0;
  }
  .chips a {
    flex: 1;
    height: 52px;
    border-radius: 12px;
    border: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: center;
    font: 500 20px var(--sans);
    color: var(--ink);
    text-decoration: none;
  }
  .rail {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    /* Rows grow when a line wraps at narrow widths (#20: wrap, never truncate). */
    grid-template-rows: minmax(88px, auto) minmax(88px, auto);
    gap: 8px;
  }
</style>
