<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { fromMl, type Side } from '@bht/schema';
  import { app, time } from '../../lib/ui/app.svelte.ts';
  import {
    ago,
    clock,
    followsFeed,
    lastPump,
    lastPumpMl,
    MAX_FEED_SECONDS,
    minutes as mins,
    pumpData,
    pumpSide,
    pumpsLeft,
    pumpsRight,
    runningPump,
    snapBottle,
    startPumpData,
    stopSeconds,
  } from '../../lib/ui/logic.ts';
  import TimeRow from '../../lib/ui/TimeRow.svelte';
  import Toast from '../../lib/ui/Toast.svelte';
  import Vessel from '../../lib/ui/Vessel.svelte';
  import { fromLocalInput, toLocalInput } from '../../lib/ui/time.ts';

  const running = $derived(runningPump(app.events));
  const last = $derived(lastPump(app.events));
  const elapsed = $derived(running ? app.now - Date.parse(running.occurredAt) : 0);

  // Before a pump: the sides to start on, following the last pump until the parent picks.
  let picked = $state<Side | null>(null);
  const side = $derived(running ? pumpSide(running) : (picked ?? (last ? pumpSide(last) : 'both')));

  /**
   * The volume form: after Stop (`stoppedAt` holds the end, so the duration does not grow while
   * the parent fills in volumes) or for a past pump. Nothing is saved until Log.
   */
  let form = $state<'stop' | 'past' | null>(null);
  let stoppedAt = $state(0);
  let left = $state(snapBottle(lastPumpMl(app.events, 'left'), app.prefs.volume));
  let right = $state(snapBottle(lastPumpMl(app.events, 'right'), app.prefs.volume));
  // A past pump's start; null is now.
  let at = $state<string | null>(null);
  let afterPick = $state<boolean | null>(null);
  const start = $derived(
    form === 'stop' && running
      ? Date.parse(running.occurredAt)
      : at === null
        ? app.now
        : Date.parse(at),
  );
  const afterFeed = $derived(afterPick ?? followsFeed(app.events, start));

  /** Past the schema's 4-hour bound the timer was left running: the parent types the minutes. */
  const seconds = $derived(
    running && form === 'stop' ? stopSeconds(running.occurredAt, stoppedAt) : null,
  );
  const overrun = $derived(form === 'stop' && seconds === null);
  let typedMinutes = $state<number | null>(null);
  const validMinutes = $derived(
    typedMinutes !== null &&
      Number.isFinite(typedMinutes) &&
      typedMinutes >= 1 &&
      typedMinutes * 60 <= MAX_FEED_SECONDS,
  );

  let busy = false;
  async function once(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      // The form stays as entered so the parent can try again.
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

  const startPump = () =>
    once(() => app.log('pump', startPumpData(side), `Pump started · ${side}`));

  function stop() {
    stoppedAt = Date.now();
    afterPick = null;
    typedMinutes = null;
    form = 'stop';
  }

  function logPast() {
    at = null;
    afterPick = null;
    form = 'past';
  }

  const volumes = $derived(
    [
      pumpsLeft(side) ? `L ${app.volume(left)}` : null,
      pumpsRight(side) ? `R ${app.volume(right)}` : null,
    ]
      .filter((v) => v !== null)
      .join(' · '),
  );

  const save = () =>
    once(async () => {
      if (form === 'stop') {
        if (!running) return;
        const s = seconds ?? (validMinutes ? Math.round(typedMinutes! * 60) : null);
        if (s === null) return;
        const change = await app.store.edit(running.id, {
          data: pumpData(side, { left, right }, afterFeed, s),
        });
        app.showUndo(`Pump · ${mins(s)} · ${volumes} logged`, change);
      } else {
        await app.log(
          'pump',
          pumpData(side, { left, right }, afterFeed),
          `Pump · ${volumes} logged`,
          {
            occurredAt: at ?? undefined,
          },
        );
      }
      await goto(resolve('/'), { replaceState: true });
    });

  async function moveStart(value: string) {
    const iso = fromLocalInput(value);
    if (!running || !iso) return;
    const ms = Date.parse(iso);
    const now = Date.now();
    if (ms > now || now - ms > MAX_FEED_SECONDS * 1000) return;
    try {
      await app.store.edit(running.id, { occurredAt: iso });
    } catch (e) {
      app.fail(e);
    }
  }
</script>

<main class="screen fade">
  <header class="top">
    <h1>Pump</h1>
    {#if running && form === null}
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

  {#if form}
    {#if form === 'past'}
      <TimeRow bind:at label="Started" />
      <div class="seg">
        {#each SIDES as [s, label] (s)}
          <button aria-pressed={side === s} onclick={() => (picked = s)}>{label}</button>
        {/each}
      </div>
    {:else if running && overrun}
      <p class="overrun" role="status">
        Timer ran {ago(app.now - Date.parse(running.occurredAt))}.
      </p>
      <label class="typed">
        <span class="lab">Minutes from {time(running.occurredAt)}</span>
        <input type="number" inputmode="numeric" min="1" max="240" bind:value={typedMinutes} />
      </label>
    {:else if seconds !== null}
      <p class="lab summary">{side === 'both' ? 'Both sides' : `${side} side`} · {mins(seconds)}</p>
    {/if}

    <div class="vessels" class:two={side === 'both'}>
      {#if pumpsLeft(side)}
        <div class="side">
          <span class="lab">Left</span>
          <div class="hold"><Vessel bind:ml={left} label="Left amount" /></div>
          <span class="num amt">{Math.round(left)} mL · {fromMl(left, 'oz').toFixed(1)} oz</span>
        </div>
      {/if}
      {#if pumpsRight(side)}
        <div class="side">
          <span class="lab">Right</span>
          <div class="hold"><Vessel bind:ml={right} label="Right amount" /></div>
          <span class="num amt">{Math.round(right)} mL · {fromMl(right, 'oz').toFixed(1)} oz</span>
        </div>
      {/if}
    </div>

    <p class="lab ask">Right after a feed?</p>
    <div class="seg after">
      <button aria-pressed={afterFeed} onclick={() => (afterPick = true)}>Yes</button>
      <button aria-pressed={!afterFeed} onclick={() => (afterPick = false)}>No</button>
    </div>

    <div class="toast"><Toast /></div>
    <button class="go2" onclick={() => (form = null)}
      >{form === 'stop' ? 'Back to the timer' : 'Back'}</button
    >
    <button class="go" disabled={overrun && !validMinutes} onclick={save}>
      {overrun && !validMinutes ? 'Type the minutes' : `Log ${volumes}`}
    </button>
  {:else}
    <div class="big">
      {#if running}
        <span class="lab">{side === 'both' ? 'Both sides' : `${side} side`}</span>
        <div class="v num">{clock(elapsed)}</div>
      {:else}
        <span class="lab">Pump on</span>
        <div class="v num">{clock(0)}</div>
      {/if}
      <span class="lab"
        >{last
          ? `Last pump ${pumpSide(last)} · ${ago(app.now - Date.parse(last.occurredAt))}${app.now - Date.parse(last.occurredAt) >= 60_000 ? ' ago' : ''}`
          : 'First pump'}</span
      >
    </div>

    {#if !running}
      <div class="sides">
        {#each SIDES as [s, label] (s)}
          <button aria-pressed={side === s} onclick={() => (picked = s)}>
            {label}<small>{side === s ? '●' : ''}</small>
          </button>
        {/each}
      </div>
    {/if}
    <div class="toast"><Toast /></div>

    {#if running}
      <button class="go" onclick={stop}
        >{elapsed > MAX_FEED_SECONDS * 1000
          ? 'Stop · set the duration'
          : `Stop · ${mins(elapsed / 1000)}`}</button
      >
    {:else}
      <button class="go2" onclick={logPast}>Log a past pump</button>
      <button class="go" onclick={startPump}>Start · {side}</button>
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
    font: 400 15px var(--mono);
    color: var(--dim);
    min-height: 1em;
  }
  .toast {
    margin: 0 16px 10px;
  }
  .summary,
  .overrun {
    text-align: center;
    margin: 18px 24px 0;
  }
  .overrun {
    font: 600 18px var(--sans);
  }
  .typed {
    display: block;
    text-align: center;
    margin-top: 10px;
  }
  .typed input {
    display: block;
    width: 3.2em;
    margin: 4px auto;
    text-align: center;
    border: none;
    border-bottom: 2px solid var(--line);
    background: none;
    font: 200 48px/1.1 var(--sans);
    outline: none;
  }
  .vessels {
    display: grid;
    grid-template-columns: 150px;
    justify-content: center;
    gap: 24px;
    margin: 18px 16px 0;
  }
  .vessels.two {
    grid-template-columns: repeat(2, 130px);
  }
  .side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .hold {
    width: 100%;
    height: min(300px, calc(100dvh - 560px));
    min-height: 180px;
  }
  .amt {
    font: 400 15px var(--sans);
  }
  .ask {
    text-align: center;
    margin: 18px 0 0;
  }
  .after {
    margin-top: 8px;
    margin-bottom: 14px;
  }
</style>
