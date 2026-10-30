<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Change } from '../../lib/data/store.ts';
  import { app, time } from '../../lib/ui/app.svelte.ts';
  import { entryPath, glyph, historyDays, rowText, type HistoryDay } from '../../lib/ui/history.ts';
  import Glyph from '../../lib/ui/Glyph.svelte';
  import { marksIn } from '../../lib/ui/readings.ts';
  import { localZone } from '../../lib/ui/reports.ts';
  import Toast from '../../lib/ui/Toast.svelte';

  const tz = localZone();

  // Day headings change at the day start, not every second, so the minute is enough.
  const minute = $derived(Math.floor(app.now / 60_000));
  const days = $derived(historyDays(app.events, app.prefs.dayStart, minute * 60_000, tz));

  const iso = (ms: number) => new Date(ms).toISOString();
  const window = (d: HistoryDay) => ({ start: iso(d.start), end: iso(d.end) });

  let busy = false;
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

  /** "We missed some" (#24): this day leaves the count checks in Readings. */
  const markMissed = (d: HistoryDay) =>
    once(() =>
      app.log('missed_logs', window(d), 'Missed some', {
        occurredAt: iso(d.start),
        day: d.label,
      }),
    );

  /** "We logged everything": takes back every mark touching this day, with one Undo. */
  const unmark = (d: HistoryDay) =>
    once(async () => {
      const changes: Change[] = [];
      for (const m of marksIn(app.events, window(d))) changes.push(await app.store.remove(m.id));
      const last = changes.at(-1);
      if (!last) return;
      app.showUndo(`${d.label}: we logged everything`, {
        event: last.event,
        undo: async () => {
          let undone = last;
          for (const c of changes) undone = await c.undo();
          return undone;
        },
      });
    });
</script>

<main class="screen fade">
  <header class="top">
    <span class="title-row">
      <a class="back" href={resolve('/')}>‹ History</a>
      <!-- Sync (#5) has not landed, so this is one phone's log, not both parents'. -->
      <span class="lab who">This phone only</span>
    </span>
    <a class="act" href={resolve('/reports')}>Reports ›</a>
  </header>

  <div class="toast"><Toast /></div>

  {#each days as d (d.start)}
    {@const marked = marksIn(app.events, window(d)).length > 0}
    <section>
      <h2 class="sec lab">{d.label}</h2>
      <ul class="list">
        {#each d.events as e (e.id)}
          {@const t = rowText(e, app.volume)}
          {@const g = glyph(e)}
          <li>
            <a href={resolve(entryPath(e))}>
              <span class="at num">{time(e.occurredAt)}</span>
              <span class="what">
                <span class="title">
                  {#if g}<Glyph kind={g} />{/if}{t.title}
                </span>
                {#if t.caption}<span class="cap">{t.caption}</span>{/if}
              </span>
              <span class="chev" aria-hidden="true">›</span>
            </a>
          </li>
        {/each}
      </ul>
      <div class="day-mark">
        {#if marked}
          <p class="cap">You marked missing logs for this day.</p>
          <button onclick={() => unmark(d)}>We logged everything</button>
        {:else}
          <button onclick={() => markMissed(d)}>We missed some</button>
        {/if}
      </div>
    </section>
  {:else}
    <p class="empty">Nothing logged yet.</p>
  {/each}
</main>

<style>
  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 10px;
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
  .who {
    font-size: 15px;
    color: var(--text-dim);
  }
  .toast {
    margin: 12px 16px 0;
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
  .at {
    flex: none;
    width: 5.6em;
    font: 400 15px var(--mono);
    color: var(--text-dim);
  }
  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
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
  .day-mark {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 4px 12px;
    margin: 4px 16px 0;
  }
  .day-mark .cap {
    flex: 1 1 12em;
  }
  .day-mark button {
    min-height: 48px;
    padding: 0 4px;
    font: 500 20px var(--sans);
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .empty {
    margin: 32px 24px;
    font-size: 17px;
    color: var(--text-dim);
  }
</style>
