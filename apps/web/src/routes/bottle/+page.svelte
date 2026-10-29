<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { fromMl, formatVolume, ML_PER_FL_OZ } from '@bht/schema';
  import { app } from '../../lib/ui/app.svelte.ts';
  import {
    BOTTLE_MAX_ML,
    DEFAULT_BOTTLE_ML,
    lastBottle,
    snapBottle,
    stepBottle,
  } from '../../lib/ui/logic.ts';
  import TimeRow from '../../lib/ui/TimeRow.svelte';

  const last = lastBottle(app.events);
  let contents = $state<'breast_milk' | 'formula'>(last?.data.contents ?? 'breast_milk');
  // The level starts at the last amount, so a repeat feed is two taps.
  let ml = $state(snapBottle(last?.data.volumeMl ?? DEFAULT_BOTTLE_ML, app.prefs.volume));
  let at = $state<string | null>(null);
  let vessel: HTMLDivElement;
  let busy = false;

  const pct = $derived((ml / BOTTLE_MAX_ML) * 100);
  const ML_TICKS = [0, 60, 120, 180, 240];
  const OZ_TICKS = [0, 2, 4, 6, 8];

  function fromPointer(e: PointerEvent) {
    const r = vessel.getBoundingClientRect();
    const f = 1 - (e.clientY - r.top) / r.height;
    ml = snapBottle(f * BOTTLE_MAX_ML, app.prefs.volume);
  }

  function keys(e: KeyboardEvent) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') ml = stepBottle(ml, app.prefs.volume, 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft')
      ml = stepBottle(ml, app.prefs.volume, -1);
    else return;
    e.preventDefault();
  }

  async function log() {
    if (busy || ml <= 0) return;
    busy = true;
    try {
      await app.log(
        'bottle',
        { contents, volumeMl: ml },
        `Bottle ${formatVolume(ml, app.prefs.volume)} logged`,
        {
          occurredAt: at ?? undefined,
        },
      );
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
    <h1>Bottle</h1>
  </header>
  <TimeRow bind:at />

  <div class="seg">
    <button aria-pressed={contents === 'breast_milk'} onclick={() => (contents = 'breast_milk')}
      >Breast milk</button
    >
    <button aria-pressed={contents === 'formula'} onclick={() => (contents = 'formula')}
      >Formula</button
    >
  </div>

  <div class="units lab"><span>mL</span><span>oz</span></div>
  <div class="bottle">
    <div class="scale l">
      {#each ML_TICKS as t (t)}<div style:bottom="{(t / BOTTLE_MAX_ML) * 100}%">{t}</div>{/each}
    </div>
    <div
      class="vessel"
      bind:this={vessel}
      role="slider"
      tabindex="0"
      aria-label="Amount"
      aria-valuemin={0}
      aria-valuemax={BOTTLE_MAX_ML}
      aria-valuenow={Math.round(ml)}
      aria-valuetext={formatVolume(ml, app.prefs.volume)}
      onpointerdown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e);
      }}
      onpointermove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
      }}
      onkeydown={keys}
    >
      <div class="fill" style:height="{pct}%"></div>
      <div class="grip" style:bottom="{pct}%"></div>
    </div>
    <div class="scale r">
      {#each OZ_TICKS as t (t)}<div style:bottom="{((t * ML_PER_FL_OZ) / BOTTLE_MAX_ML) * 100}%">
          {t}
        </div>{/each}
    </div>
  </div>

  <div class="readout num">
    {Math.round(ml)} <span>mL</span> · {fromMl(ml, 'oz').toFixed(1)} <span>oz</span>
  </div>

  <button class="go" disabled={ml <= 0} onclick={log}
    >Log {formatVolume(ml, app.prefs.volume)}</button
  >
</main>

<style>
  .screen {
    padding-bottom: calc(110px + var(--safe-b));
  }
  .units {
    display: flex;
    justify-content: space-between;
    margin: 14px 30px 8px;
  }
  .bottle {
    display: grid;
    grid-template-columns: 1fr 130px 1fr;
    gap: 12px;
    margin: 0 16px;
    height: min(400px, calc(100dvh - 450px));
    min-height: 220px;
  }
  .scale {
    position: relative;
    font: 500 13px var(--mono);
    color: var(--dim);
  }
  .scale div {
    position: absolute;
    transform: translateY(50%);
  }
  .scale.l div {
    right: 0;
  }
  .scale.r div {
    left: 0;
  }
  .vessel {
    position: relative;
    border: 2px solid var(--ink);
    border-radius: 26px 26px 30px 30px;
    overflow: hidden;
    background: var(--panel);
    touch-action: none;
    cursor: ns-resize;
  }
  .fill {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--band);
    border-top: 3px solid var(--acc);
  }
  .grip {
    position: absolute;
    left: 50%;
    width: 62px;
    height: 22px;
    margin-left: -31px;
    border-radius: 11px;
    background: var(--acc);
    transform: translateY(50%);
  }
  .readout {
    text-align: center;
    margin-top: 16px;
    font: 300 44px var(--sans);
  }
  .readout span {
    color: var(--dim);
    font-size: 22px;
  }
</style>
