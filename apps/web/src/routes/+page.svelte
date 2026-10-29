<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { app, time } from '../lib/ui/app.svelte.ts';
  import Dial from '../lib/ui/Dial.svelte';
  import FeedKey from '../lib/ui/FeedKey.svelte';
  import LogKey from '../lib/ui/LogKey.svelte';
  import { keyLines } from '../lib/ui/keys.ts';
  import Toast from '../lib/ui/Toast.svelte';
  import {
    ageDays,
    clock,
    countMarks,
    currentSide,
    dayMarks,
    finishFeedData,
    hm,
    minutes,
    runningFeed,
  } from '../lib/ui/logic.ts';

  const baby = $derived(app.baby!);
  const marks = $derived(dayMarks(app.events, app.now));
  const counts = $derived(countMarks(marks));
  const running = $derived(runningFeed(app.events));
  const lastFeed = $derived(app.events.find((e) => e.type === 'breastfeed' || e.type === 'bottle'));
  const lines = $derived(keyLines(app.events, app.now, app.volume));

  let busy = $state(false);

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

<main class="screen fade">
  <header class="top">
    <h1>{baby.name}</h1>
    <span class="lab num">{ageDays(baby.birthAt, app.now)} days · last 24 h</span>
  </header>

  <a
    href={resolve('/feed')}
    class="dial-link"
    aria-label={running ? 'Open the breastfeed timer' : 'Breastfeed'}
  >
    <Dial {marks} running={running?.occurredAt ?? null} now={app.now}>
      {#if running}
        <span class="lab">Feeding · {currentSide(running) ?? running.data.side}</span>
        <span class="v num">{clock(app.now - Date.parse(running.occurredAt))}</span>
        <span class="lab">since {time(running.occurredAt)}</span>
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

  <div class="dock">
    <Toast />
    <nav class="chips">
      <a href={resolve('/readings')}>Readings</a>
      <a href={resolve('/settings')}>Settings</a>
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
      <!-- Opens the pump screen once #22 (PR #32) lands; until then there is nowhere to go. -->
      <LogKey kind="pump" label="Pump" lines={lines.pump} onclick={() => {}} disabled />
    </div>
  </div>
</main>

<style>
  .screen {
    padding-bottom: calc(300px + var(--safe-b));
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
  .quiet {
    text-align: center;
    margin-top: 14px;
    font-size: 14px;
    color: var(--dim);
  }
  p.lab.quiet {
    font-size: 10px;
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
    grid-template-rows: 88px 88px;
    gap: 8px;
  }
</style>
