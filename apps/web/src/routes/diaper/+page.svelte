<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import type { StoolColor } from '@bht/schema';
  import { app } from '../../lib/ui/app.svelte.ts';
  import { FLAG_SWATCHES, NORMAL_SWATCHES } from '../../lib/ui/logic.ts';
  import TimeRow from '../../lib/ui/TimeRow.svelte';

  let mixed = $state(false);
  let at = $state<string | null>(null);
  let busy = false;

  /** The color tap is the log: the event exists before the optional details step. */
  async function pick(color: StoolColor) {
    if (busy) return;
    busy = true;
    try {
      const baby = app.baby!;
      const change = await app.store.log(
        baby.id,
        'diaper',
        {
          kind: mixed ? 'mixed' : 'dirty',
          stool: { color, consistency: null, size: null, flags: [] },
        },
        { occurredAt: at ?? undefined },
      );
      await goto(resolve(`/diaper/details?id=${change.event.id}&new`), { replaceState: true });
    } catch (e) {
      app.fail(e);
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen fade">
  <header class="top">
    <h1>{mixed ? 'Mixed diaper' : 'Dirty diaper'}</h1>
  </header>
  <div class="steps"><i class="on"></i><i></i></div>
  <TimeRow bind:at />

  <label class="toggle">
    <span>Also wet <span class="dim">· mixed</span></span>
    <input type="checkbox" role="switch" bind:checked={mixed} />
  </label>

  <section class="well">
    <div class="lab">Color · true in every mode</div>
    <div class="grid three">
      {#each NORMAL_SWATCHES as s (s.color)}
        <button
          class="tile"
          class:dk={s.dark}
          style:background={s.hex}
          onclick={() => pick(s.color)}
        >
          {s.label}
        </button>
      {/each}
    </div>
    <div class="lab flagnote">! Consider talking to your pediatrician</div>
    <div class="grid four">
      {#each FLAG_SWATCHES as s (s.color)}
        <button
          class="tile sm fl"
          class:dk={s.dark}
          style:background={s.hex}
          onclick={() => pick(s.color)}
        >
          {s.label}
        </button>
      {/each}
    </div>
  </section>

  <p class="hint lab">Tap a color to log · details are optional</p>
  <a class="go2 cancel" href={resolve('/')}>Cancel</a>
</main>

<style>
  .steps {
    display: flex;
    gap: 6px;
    margin: 14px 24px 0;
  }
  .steps i {
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: var(--line);
  }
  .steps i.on {
    background: var(--ink);
  }
  .toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 10px 16px 0;
    padding: 0 16px;
    height: 56px;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .dim {
    color: var(--dim);
  }
  input[role='switch'] {
    appearance: none;
    width: 50px;
    height: 30px;
    border-radius: 15px;
    background: var(--line);
    position: relative;
    cursor: pointer;
  }
  input[role='switch']::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--bg);
    transition: left 0.12s;
  }
  input[role='switch']:checked {
    background: var(--acc);
  }
  input[role='switch']:checked::after {
    left: 23px;
    background: var(--acc-ink);
  }
  /* Swatches sit in their own well and never take the theme tint. */
  .well {
    margin: 14px 16px 0;
    border-radius: 18px;
    padding: 14px;
    background: var(--well);
    border: 1px solid var(--line);
  }
  .grid {
    display: grid;
    gap: 8px;
    margin-top: 10px;
  }
  .three {
    grid-template-columns: repeat(3, 1fr);
  }
  .four {
    grid-template-columns: repeat(4, 1fr);
    margin-top: 0;
  }
  .tile {
    height: 84px;
    border-radius: 12px;
    position: relative;
    padding: 8px 10px;
    font: 500 12px var(--sans);
    display: flex;
    align-items: flex-end;
    text-align: left;
    color: rgba(0, 0, 0, 0.7);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  }
  .tile:active {
    transform: scale(0.96);
  }
  .tile.dk {
    color: rgba(255, 255, 255, 0.85);
  }
  .tile.sm {
    height: 64px;
  }
  .tile.fl::after {
    content: '!';
    position: absolute;
    top: 6px;
    right: 9px;
    font: 700 12px var(--mono);
  }
  .flagnote {
    margin: 16px 2px 8px;
    color: var(--flag);
  }
  .hint {
    text-align: center;
    margin-top: 18px;
  }
  .cancel {
    position: fixed;
    bottom: calc(30px + var(--safe-b));
    left: max(16px, calc(50% - 224px));
    right: max(16px, calc(50% - 224px));
    width: auto;
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink);
    text-decoration: none;
    background: var(--bg);
  }
</style>
