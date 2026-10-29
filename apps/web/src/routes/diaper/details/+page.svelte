<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Stool } from '@bht/schema';
  import { app, time } from '../../../lib/ui/app.svelte.ts';
  import { describe, swatch, type Diaper } from '../../../lib/ui/logic.ts';

  type Consistency = NonNullable<Stool['consistency']>;
  type Size = NonNullable<Stool['size']>;
  type Flag = Stool['flags'][number];

  const CONSISTENCY: [Consistency, string][] = [
    ['seedy', 'Seedy'],
    ['pasty', 'Pasty'],
    ['loose', 'Loose'],
    ['watery', 'Watery'],
    ['formed', 'Formed'],
    ['hard', 'Hard'],
  ];
  const SIZES: [Size, string][] = [
    ['small', 'Small'],
    ['medium', 'Medium'],
    ['large', 'Large'],
  ];
  const FLAGS: [Flag, string][] = [
    ['blood', 'Blood'],
    ['mucus', 'Mucus'],
    ['other', 'Other'],
  ];

  const id = page.url.searchParams.get('id') ?? '';
  const event = $derived(
    app.events.find(
      (e): e is Diaper => e.id === id && e.type === 'diaper' && e.data.kind !== 'wet',
    ),
  );
  const stool = $derived(event && event.data.kind !== 'wet' ? event.data.stool : null);

  let consistency = $state<Consistency | null>(null);
  let size = $state<Size | null>(null);
  let flags = $state<Flag[]>([]);
  let busy = false;

  const toggle = (f: Flag) =>
    (flags = flags.includes(f) ? flags.filter((x) => x !== f) : [...flags, f]);

  async function done() {
    if (busy || !event || event.data.kind === 'wet') return;
    busy = true;
    try {
      const touched = consistency !== null || size !== null || flags.length > 0;
      if (touched) {
        await app.store.edit(event.id, {
          data: {
            kind: event.data.kind,
            stool: { color: stool?.color ?? null, consistency, size, flags },
          },
        });
      }
      // Undo on home takes back the whole diaper, which is what was just logged.
      app.showUndo(`${describe(event, app.volume)} logged · ${time(event.occurredAt)}`, {
        event,
        undo: () => app.store.remove(event.id),
      });
      await goto(resolve('/'), { replaceState: true });
    } catch (e) {
      app.fail(e);
    } finally {
      busy = false;
    }
  }

  async function undo() {
    if (busy || !event) return;
    busy = true;
    try {
      await app.store.remove(event.id);
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
    <h1>Details</h1>
    <span class="lab">Optional</span>
  </header>
  <div class="steps"><i class="on"></i><i class="on"></i></div>

  {#if event}
    <div class="done">
      <span class="chip" style:background={swatch(stool?.color)?.hex ?? 'var(--line)'}></span>
      <div>
        Logged · {describe(event, app.volume).toLowerCase()}<small>{time(event.occurredAt)}</small>
      </div>
      <button onclick={undo}>Undo</button>
    </div>

    <div class="sec lab">Texture</div>
    <div class="opts three">
      {#each CONSISTENCY as [value, label] (value)}
        <button
          aria-pressed={consistency === value}
          onclick={() => (consistency = consistency === value ? null : value)}>{label}</button
        >
      {/each}
    </div>
    <div class="sec lab">Size</div>
    <div class="opts three">
      {#each SIZES as [value, label] (value)}
        <button aria-pressed={size === value} onclick={() => (size = size === value ? null : value)}
          >{label}</button
        >
      {/each}
    </div>
    <div class="sec lab">Also noticed</div>
    <div class="opts three">
      {#each FLAGS as [value, label] (value)}
        <button aria-pressed={flags.includes(value)} onclick={() => toggle(value)}>{label}</button>
      {/each}
    </div>
    <button class="go" onclick={done}>Done</button>
  {:else}
    <p class="gone">This diaper is no longer in the log.</p>
    <a class="go back" href={resolve('/')}>Home</a>
  {/if}
</main>

<style>
  .screen {
    padding-bottom: calc(120px + var(--safe-b));
  }
  .steps {
    display: flex;
    gap: 6px;
    margin: 14px 24px 0;
  }
  .steps i {
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: var(--ink);
  }
  .done {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 18px 16px 0;
    padding: 6px 0 6px 16px;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .chip {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    flex: none;
  }
  .done div {
    flex: 1;
    font-size: 15px;
  }
  .done small {
    display: block;
    color: var(--dim);
    font-size: 13px;
    margin-top: 2px;
  }
  .done button {
    align-self: stretch;
    padding: 0 16px;
    font-weight: 600;
    font-size: 15px;
  }
  .three {
    grid-template-columns: repeat(3, 1fr);
  }
  .gone {
    margin: 32px 24px;
    color: var(--dim);
  }
  .back {
    display: flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
  }
</style>
