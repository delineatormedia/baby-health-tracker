<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { fromMl, formatVolume, ML_PER_FL_OZ } from '@bht/schema';
  import { app } from '../../lib/ui/app.svelte.ts';
  import { BOTTLE_MAX_ML, DEFAULT_BOTTLE_ML, lastBottle, snapBottle } from '../../lib/ui/logic.ts';
  import TimeRow from '../../lib/ui/TimeRow.svelte';
  import Vessel from '../../lib/ui/Vessel.svelte';

  const last = lastBottle(app.events);
  let contents = $state<'breast_milk' | 'formula'>(last?.data.contents ?? 'breast_milk');
  // The level starts at the last amount, so a repeat feed is two taps.
  let ml = $state(snapBottle(last?.data.volumeMl ?? DEFAULT_BOTTLE_ML, app.prefs.volume));
  let at = $state<string | null>(null);
  let busy = false;

  const ML_TICKS = [0, 60, 120, 180, 240];
  const OZ_TICKS = [0, 2, 4, 6, 8];

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
    <Vessel bind:ml />
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
