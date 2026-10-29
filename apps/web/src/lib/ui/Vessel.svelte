<script lang="ts">
  import { formatVolume } from '@bht/schema';
  import { app } from './app.svelte.ts';
  import { BOTTLE_MAX_ML, snapBottle, stepBottle } from './logic.ts';

  /** The drag-to-fill volume scale from Bottle, snapped to 5 mL or 0.5 oz. */
  let { ml = $bindable(), label = 'Amount' }: { ml: number; label?: string } = $props();

  let vessel: HTMLDivElement;
  const pct = $derived((ml / BOTTLE_MAX_ML) * 100);

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
</script>

<div
  class="vessel"
  bind:this={vessel}
  role="slider"
  tabindex="0"
  aria-label={label}
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

<style>
  .vessel {
    position: relative;
    height: 100%;
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
    max-width: 70%;
    height: 22px;
    margin-left: -31px;
    border-radius: 11px;
    background: var(--acc);
    transform: translateY(50%);
  }
</style>
