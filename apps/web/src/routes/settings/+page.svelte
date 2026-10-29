<script lang="ts">
  import { resolve } from '$app/paths';
  import type { VolumeDisplay } from '@bht/schema';
  import { app } from '../../lib/ui/app.svelte.ts';
  import type { Theme } from '../../lib/ui/prefs.ts';
  import { dayStartText } from '../../lib/ui/reports.ts';
  import HomeScreenNote from '../../lib/ui/HomeScreenNote.svelte';

  const VOLUMES: [VolumeDisplay, string][] = [
    ['ml', 'mL'],
    ['oz', 'oz'],
    ['both', 'Both'],
  ];
  const THEMES: [Theme, string][] = [
    ['auto', 'Auto'],
    ['night', 'On'],
    ['light', 'Off'],
  ];
  /** Day starts at (#21), minutes after midnight. Other opens the phone's time wheel. */
  const DAY_STARTS = [0, 360, 420, 480, 540];
  const other = $derived(!DAY_STARTS.includes(app.prefs.dayStart));
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
</script>

<main class="screen fade">
  <header class="top">
    <a class="back" href={resolve('/')}>‹ Settings</a><span class="lab">This phone</span>
  </header>

  <div class="sec lab">Volumes</div>
  <div class="opts three">
    {#each VOLUMES as [value, label] (value)}
      <button
        aria-pressed={app.prefs.volume === value}
        onclick={() => app.setPrefs({ volume: value })}>{label}</button
      >
    {/each}
  </div>

  <div class="sec lab">Night mode</div>
  <div class="opts three">
    {#each THEMES as [value, label] (value)}
      <button
        aria-pressed={app.prefs.theme === value}
        onclick={() => app.setPrefs({ theme: value })}>{label}</button
      >
    {/each}
  </div>
  <p class="note">Auto follows the phone's dark mode.</p>

  <div class="sec lab">Day starts at</div>
  <div class="opts three day">
    {#each DAY_STARTS as m (m)}
      <button aria-pressed={app.prefs.dayStart === m} onclick={() => app.setPrefs({ dayStart: m })}
        >{dayStartText(m)}</button
      >
    {/each}
    <!-- A transparent native time wheel over the option, like TimeRow's Other time. -->
    <label class="other" class:on={other}>
      {other ? dayStartText(app.prefs.dayStart) : 'Other ›'}
      <input
        type="time"
        aria-label="Other day start time"
        value={hhmm(app.prefs.dayStart)}
        onchange={(e) => {
          const [h, m] = e.currentTarget.value.split(':').map(Number);
          if (Number.isInteger(h) && Number.isInteger(m)) app.setPrefs({ dayStart: h! * 60 + m! });
        }}
      />
    </label>
  </div>
  <p class="note day">
    Reports start each day at <b
      >{app.prefs.dayStart === 0 ? 'midnight' : dayStartText(app.prefs.dayStart)}</b
    >{app.prefs.dayStart > 0 && app.prefs.dayStart <= 600
      ? ', so a 3 AM feed counts as the night before'
      : ''}. Readings don't change: they always count from {app.baby?.name ?? 'the baby'}'s birth
    time. This phone only, until sync.
  </p>

  <div class="sec lab">Storage</div>
  <p class="note day" role="status">
    {#if app.persistence === 'persisted'}
      <b>Kept.</b> This browser has promised not to clear the logs on this phone.
    {:else if app.persistence === 'not-persisted'}
      <b>Not protected.</b> This browser may clear the logs on this phone{app.standalone
        ? ' if it runs low on space'
        : ''}.
    {:else}
      <b>Unknown.</b> This browser doesn't say whether it keeps the logs on this phone.
    {/if}
  </p>
  <HomeScreenNote />

  <div class="sec lab">Sync</div>
  <p class="note">
    Logs are saved on this phone. Sign-in and sharing with the other parent come next.
  </p>
  {#if app.rejected > 0}
    <p class="note refused" role="status">
      <b>{app.rejected} {app.rejected === 1 ? 'entry' : 'entries'} the server refused.</b> They are still
      on this phone and were not shared.
    </p>
  {/if}
</main>

<style>
  .three {
    grid-template-columns: repeat(3, 1fr);
  }
  .note {
    margin: 10px 24px 0;
    font-size: 15px;
    color: var(--dim);
  }
  /* The #20 type rules for the new setting: 20 px controls, 15 px text at 4.5:1. */
  .day {
    position: relative;
  }
  .day button {
    font-size: 20px;
  }
  .note.day {
    font-size: 15px;
    color: var(--text-dim);
  }
  .note.day b {
    color: var(--ink);
    font-weight: 500;
  }
  .note.refused {
    font-size: 15px;
    color: var(--text-dim);
  }
  .note.refused b {
    color: var(--ink);
    font-weight: 500;
  }
  .other {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 52px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: var(--panel);
    font-size: 20px;
    cursor: pointer;
  }
  .other.on {
    border: 2px solid var(--ink);
    font-weight: 600;
  }
  .other input {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
  }
</style>
