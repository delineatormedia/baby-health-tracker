<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { app, time } from '../lib/ui/app.svelte.ts';
  import Dial from '../lib/ui/Dial.svelte';
  import Toast from '../lib/ui/Toast.svelte';
  import {
    ageDays,
    ago,
    clock,
    countMarks,
    dayMarks,
    hm,
    DEFAULT_BOTTLE_ML,
    lastBottle,
    lastDiaperAt,
    runningFeed,
    stopSeconds,
    suggestSide,
  } from '../lib/ui/logic.ts';

  const baby = $derived(app.baby!);
  const marks = $derived(dayMarks(app.events, app.now));
  const counts = $derived(countMarks(marks));
  const running = $derived(runningFeed(app.events));
  const lastFeed = $derived(app.events.find((e) => e.type === 'breastfeed' || e.type === 'bottle'));
  const diaperAt = $derived(lastDiaperAt(app.events));
  const bottleMl = $derived(lastBottle(app.events)?.data.volumeMl ?? DEFAULT_BOTTLE_ML);

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

  const startFeed = () =>
    once(() =>
      app.log(
        'breastfeed',
        { side: suggestSide(app.events), durationSeconds: null },
        'Breastfeed started',
      ),
    );

  const stopFeed = () =>
    once(async () => {
      if (!running) return;
      const seconds = stopSeconds(running.occurredAt, Date.now());
      // Past the 4-hour bound: save nothing, ask how long the feed really was.
      if (seconds === null) return goto(resolve('/feed?fix'));
      const change = await app.store.edit(running.id, {
        data: { ...running.data, durationSeconds: seconds },
      });
      app.showUndo(`Breastfeed · ${Math.max(1, Math.round(seconds / 60))} min logged`, change);
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
        <span class="lab">Feeding · {running.data.side}</span>
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

  <div class="legend lab num">
    <span><i class="feed"></i>Feed {counts.feed}</span>
    <span><i class="wet"></i>Wet {counts.wet}</span>
    <span><i class="dirty"></i>Dirty {counts.dirty}</span>
  </div>
  <p class="quiet">
    {#if diaperAt}
      Last diaper <b class="num">{ago(app.now - Date.parse(diaperAt))}</b>{app.now -
        Date.parse(diaperAt) >=
      60_000
        ? ' ago'
        : ''}
    {:else}
      No diapers logged yet
    {/if}
  </p>
  <p class="quiet lab">Saved on this phone · not synced</p>

  <div class="dock">
    <Toast />
    <nav class="chips">
      <a href={resolve('/readings')}>Readings</a>
      <a href={resolve('/settings')}>Settings</a>
    </nav>
    <div class="rail">
      {#if running}
        <button class="run" onclick={stopFeed}>
          Stop<small class="num"
            >{running.data.side[0]?.toUpperCase()} · {clock(
              app.now - Date.parse(running.occurredAt),
            )}</small
          >
        </button>
      {:else}
        <button onclick={startFeed}>Feed<small>Start {suggestSide(app.events)}</small></button>
      {/if}
      <button onclick={wet}>Wet<small>1 tap</small></button>
      <button onclick={() => goto(resolve('/diaper'))}>Dirty<small>Color</small></button>
      <button onclick={() => goto(resolve('/bottle'))}
        >Bottle<small>{app.volume(bottleMl)}</small></button
      >
    </div>
  </div>
</main>

<style>
  .screen {
    padding-bottom: calc(240px + var(--safe-b));
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
    justify-content: center;
    gap: 18px;
    margin-top: 14px;
  }
  .legend span {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .legend i {
    display: inline-block;
    width: 8px;
    height: 8px;
  }
  .legend .feed {
    background: var(--acc);
    border-radius: 50%;
  }
  .legend .wet {
    background: var(--ink);
    border-radius: 50%;
  }
  .legend .dirty {
    border: 1.6px solid var(--ink);
    width: 7px;
    height: 7px;
  }
  .quiet {
    text-align: center;
    margin-top: 14px;
    font-size: 14px;
    color: var(--dim);
  }
  .quiet b {
    color: var(--ink);
    font-weight: 500;
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
    height: 44px;
    border-radius: 12px;
    border: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: var(--dim);
    text-decoration: none;
  }
  .rail {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .rail button {
    height: 112px;
    border-radius: 16px;
    background: var(--panel);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: flex-start;
    padding: 12px 10px;
    font: 600 16px var(--sans);
    text-align: left;
  }
  .rail button:active {
    transform: scale(0.97);
  }
  .rail small {
    font: 400 10px var(--mono);
    color: var(--dim);
    margin-top: 4px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .rail .run {
    background: var(--acc);
    color: var(--acc-ink);
    border-color: var(--acc);
  }
  .rail .run small {
    color: var(--acc-ink);
    opacity: 0.7;
  }
</style>
