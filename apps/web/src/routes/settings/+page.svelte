<script lang="ts">
  import { resolve } from '$app/paths';
  import type { VolumeDisplay } from '@bht/schema';
  import type { Invite } from '@bht/schema';
  import { signInFailure } from '../../lib/data/account.ts';
  import { app } from '../../lib/ui/app.svelte.ts';
  import SignIn from '../../lib/ui/SignIn.svelte';
  import SyncStatus from '../../lib/ui/SyncStatus.svelte';
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
  let signIn = $state<'register' | 'join' | 'login' | null>(null);
  let invite = $state.raw<Invite | null>(null);
  let busy = $state(false);
  let syncError = $state<string | null>(null);

  /** Runs a sync-section action; its failure shows under the section. */
  async function act(run: () => Promise<unknown>) {
    busy = true;
    syncError = null;
    try {
      await run();
    } catch (e) {
      syncError = signInFailure(e);
    } finally {
      busy = false;
    }
  }
  const expires = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
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

  <div class="sec lab" id="storage">Storage</div>
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
  <SyncStatus
    signedIn={app.account !== null}
    status={app.syncStatus}
    error={app.syncError}
    rejected={app.rejected}
  />
  {#if !app.account}
    {#if signIn}
      <SignIn mode={signIn} onDone={() => (signIn = null)} />
      <button class="go2 gap" onclick={() => (signIn = null)}>Cancel</button>
    {:else}
      <div class="acts">
        <button class="go2" onclick={() => (signIn = 'register')}
          >Share with the other parent</button
        >
        <button class="go2" onclick={() => (signIn = 'join')}>Join the other parent</button>
        <button class="go2" onclick={() => (signIn = 'login')}>Sign in</button>
      </div>
      <p class="note">
        Share makes a household for {app.baby?.name ?? 'the baby'} with a passkey on this phone.
      </p>
    {/if}
  {:else}
    <div class="acts">
      {#if app.syncStatus === 'signed_out'}
        <SignIn mode="login" />
      {:else if app.account.placed === false}
        <button class="go2" disabled={busy} onclick={() => act(() => app.place())}>Try again</button
        >
      {:else}
        <button
          class="go2"
          disabled={busy}
          onclick={() => act(async () => (invite = await app.invite()))}
        >
          Invite the other parent
        </button>
      {/if}
      {#if invite}
        <p class="note invite" role="status">
          Code <b class="num">{invite.code.slice(0, 5)} {invite.code.slice(5)}</b>. Enter it on
          their phone under Join the other parent. Works once, until {expires(invite.expiresAt)}.
        </p>
      {/if}
      <button
        class="go2"
        disabled={busy || app.transition === 'signIn'}
        onclick={() => act(() => app.signOut())}>Sign out</button
      >
    </div>
    <p class="note">Signing out keeps this phone's logs here.</p>
  {/if}
  {#if syncError}<p class="note err" role="alert">{syncError}</p>{/if}
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
  .acts {
    display: grid;
    gap: 8px;
    margin-top: 12px;
  }
  .gap {
    margin-top: 8px;
  }
  .note.invite b {
    color: var(--ink);
    font: 600 20px var(--mono);
    letter-spacing: 0.06em;
  }
  .note.err {
    color: var(--flag);
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
