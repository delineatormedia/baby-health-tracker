<script lang="ts">
  import { resolve } from '$app/paths';
  import type { VolumeDisplay } from '@bht/schema';
  import { app } from '../../lib/ui/app.svelte.ts';
  import type { Theme } from '../../lib/ui/prefs.ts';

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

  <div class="sec lab">Sync</div>
  <p class="note">
    Logs are saved on this phone. Sign-in and sharing with the other parent come next.
  </p>
</main>

<style>
  .back {
    font: 600 17px var(--sans);
  }
  .three {
    grid-template-columns: repeat(3, 1fr);
  }
  .note {
    margin: 10px 24px 0;
    font-size: 13px;
    color: var(--dim);
  }
</style>
