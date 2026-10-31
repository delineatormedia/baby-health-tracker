<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { gramsToLbOz } from '@bht/schema';
  import { app } from '../../lib/ui/app.svelte.ts';
  import { grams, lbOz, weightPair, weightText } from '../../lib/ui/history.ts';
  import TimeRow from '../../lib/ui/TimeRow.svelte';
  import { when } from '../../lib/ui/time.ts';
  import {
    backspace,
    gramsFromDigits,
    gramsFromLbOz,
    MAX_GRAMS,
    MIN_GRAMS,
    typeDigit,
    weights,
  } from '../../lib/ui/weight.ts';

  const all = $derived(weights(app.events));
  const latest = $derived(all[0]);

  // A clinic visit and the home scale are both common; start where the last one was taken.
  let source = $state<'home' | 'clinic'>(weights(app.events)[0]?.data.source ?? 'home');
  // Opens in the parent's unit (#84); the toggle below switches for this entry only.
  let unit = $state(app.prefs.weight);
  let digits = $state('');
  let lb = $state('');
  let oz = $state('');
  let at = $state<string | null>(null);
  // Grams carried into lb/oz: oz is shown to 0.1, so an untouched carry keeps the exact grams.
  let carried = $state<{ lb: string; oz: string; grams: number } | null>(null);
  let busy = false;

  const value = $derived(
    unit === 'g'
      ? gramsFromDigits(digits)
      : carried && carried.lb === lb && carried.oz === oz
        ? carried.grams
        : gramsFromLbOz(lb, oz),
  );
  const typed = $derived(unit === 'g' ? digits !== '' : lb !== '' || oz !== '');

  const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  function switchUnit() {
    // Carry what was typed across, so a parent can check the other unit before logging.
    if (unit === 'g') {
      if (value !== null) {
        const w = gramsToLbOz(value);
        lb = String(w.lb);
        oz = String(w.oz);
        carried = { lb, oz, grams: value };
      }
      unit = 'lb';
    } else {
      if (value !== null) digits = String(Math.round(value));
      unit = 'g';
    }
  }

  async function log() {
    if (busy || value === null) return;
    busy = true;
    try {
      await app.log(
        'weight',
        { grams: value, source },
        `Weight ${weightText(value, unit)} logged`,
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
    <a class="back" href={resolve('/')}>‹ Weight</a>
  </header>
  <TimeRow bind:at />

  <div class="seg">
    <button aria-pressed={source === 'home'} onclick={() => (source = 'home')}>Home scale</button>
    <button aria-pressed={source === 'clinic'} onclick={() => (source = 'clinic')}>Clinic</button>
  </div>

  {#if unit === 'g'}
    <div class="readout num" aria-live="polite">
      <span class="big">{digits === '' ? '0' : grams(Number(digits)).slice(0, -2)}</span>
      <span class="u">g</span>
    </div>
  {:else}
    <div class="readout lbs">
      <label
        ><input
          class="num"
          inputmode="numeric"
          enterkeyhint="next"
          bind:value={lb}
          aria-label="Pounds"
        /><span class="u">lb</span></label
      >
      <label
        ><input
          class="num"
          inputmode="decimal"
          enterkeyhint="done"
          bind:value={oz}
          aria-label="Ounces"
        /><span class="u">oz</span></label
      >
    </div>
  {/if}
  <p class="sub num">
    {#if typed && value === null}
      Between {grams(MIN_GRAMS)} and {grams(MAX_GRAMS)}{unit === 'lb' ? ', under 16 oz' : ''}
    {:else if value !== null}
      {unit === 'g' ? lbOz(value) : grams(value)}{latest
        ? ` · last ${weightText(latest.data.grams, unit)}`
        : ''}
    {:else if latest}
      Last {weightPair(latest.data.grams, unit)}
    {:else}
      No weight logged yet
    {/if}
  </p>

  <div class="pad">
    {#if unit === 'g'}
      {#each DIGITS as d (d)}
        <button class="num" onclick={() => (digits = typeDigit(digits, d))}>{d}</button>
      {/each}
    {/if}
    <button class="alt" onclick={switchUnit}>{unit === 'g' ? 'lb/oz' : 'Grams'}</button>
    {#if unit === 'g'}
      <button class="num" onclick={() => (digits = typeDigit(digits, '0'))}>0</button>
      <button aria-label="Delete a digit" onclick={() => (digits = backspace(digits))}>⌫</button>
    {/if}
  </div>

  {#if all.length > 0}
    <h2 class="sec lab">Weights</h2>
    <ul class="list">
      {#each all as w (w.id)}
        <li>
          <a href={resolve(`/history/entry?id=${w.id}`)}>
            <span class="what">
              <span class="title num">{weightText(w.data.grams, app.prefs.weight)}</span>
              <span class="cap num"
                >{weightText(w.data.grams, app.prefs.weight === 'lb' ? 'g' : 'lb')} · {w.data
                  .source === 'clinic'
                  ? 'Clinic'
                  : 'Home scale'} · {when(w.occurredAt, app.now)}</span
              >
            </span>
            <span class="chev" aria-hidden="true">›</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  <button class="go" disabled={value === null} onclick={log}
    >{value === null ? 'Log weight' : `Log ${weightText(value, unit)}`}</button
  >
</main>

<style>
  .seg button {
    font-size: 20px;
  }
  .readout {
    display: flex;
    justify-content: center;
    align-items: baseline;
    gap: 6px;
    margin-top: 22px;
  }
  .big {
    font: 300 64px/1 var(--sans);
    letter-spacing: -0.02em;
  }
  .u {
    font-size: 20px;
    color: var(--text-dim);
  }
  .lbs {
    gap: 12px;
    margin-inline: 16px;
  }
  .lbs label {
    display: flex;
    flex: 0 1 auto;
    min-width: 0;
    align-items: baseline;
    gap: 6px;
  }
  .lbs input {
    width: 3.2em;
    min-width: 0;
    flex: 0 1 auto;
    font: 300 44px/1.2 var(--sans);
    text-align: right;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 4px 10px;
  }
  .sub {
    margin: 8px 24px 0;
    text-align: center;
    font-size: 15px;
    color: var(--text-dim);
  }
  .pad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 18px 16px 0;
  }
  .pad button {
    height: 52px;
    border-radius: 12px;
    background: var(--panel);
    border: 1px solid var(--line);
    font-size: 22px;
  }
  .pad .alt {
    font-size: 20px;
  }
  .sec {
    font-size: 15px;
    color: var(--text-dim);
  }
  .list {
    list-style: none;
    margin: 0 16px;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
    overflow: hidden;
  }
  .list li + li {
    border-top: 1px solid var(--line);
  }
  .list a {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 64px;
    padding: 10px 14px;
    color: inherit;
    text-decoration: none;
  }
  .what {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    font-size: 20px;
  }
  .cap {
    font-size: 15px;
    color: var(--text-dim);
  }
  .chev {
    color: var(--text-dim);
    font-size: 20px;
  }
</style>
