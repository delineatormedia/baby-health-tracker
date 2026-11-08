<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';
  import { app } from '../lib/ui/app.svelte.ts';
  import JoinChoice from '../lib/ui/JoinChoice.svelte';
  import Setup from '../lib/ui/Setup.svelte';
  import Welcome from '../lib/ui/Welcome.svelte';
  import { watchForUpdates } from '../lib/ui/update.ts';

  let { children }: { children: Snippet } = $props();
  /** The door taken on the welcome screen (#86): Join opens Setup on the invite code. */
  let door = $state<'add' | 'join' | null>(null);

  void app.init();
  watchForUpdates({
    idle: () => !!app.baby && !app.toast && !app.saveError && !app.error,
    writing: () => app.writing,
  });

  $effect(() => {
    document.documentElement.dataset.theme = app.prefs.theme;
  });
</script>

{#if app.seeded}
  <!-- Dev test data (#58). The marker outlives every reload; only clearing site data ends it. -->
  <p class="test-data" role="status">Test data</p>
{/if}

{#if app.signingOutElsewhere}
  <!-- Step 3b: the meta flag refuses writes; this says why before anyone taps. -->
  <p class="signing-out" role="status">
    Signing out in another tab. Nothing new can be saved until it finishes or is cancelled.
  </p>
{/if}

{#if app.wipeNotice}
  <!-- This phone dropped its copy of the logs (#85). Stays until OK. -->
  <div class="wiped" role="status">
    <span>
      {app.wipeNotice.reason === 'cleared'
        ? 'The household’s data was cleared'
        : 'This phone was signed out by the server'}
      {new Date(app.wipeNotice.at).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })}. {app.wipeNotice.reason === 'cleared'
        ? 'Every baby and log is gone from the server and from every phone, and every phone was signed out. Sign in again to start over.'
        : 'Its copy of the logs went with the session. Sign in again to pick up the household’s logs.'}
    </span>
    <button onclick={() => app.dismissWipeNotice()}>OK</button>
  </div>
{/if}

{#if app.saveError}
  <div class="save-fail" role="alert">
    <span>{app.saveError?.text}</span>
    <span class="acts">
      {#if app.saveError?.retry}
        <button onclick={() => app.retrySave()}>{app.saveError?.retry?.label}</button>
      {/if}
      <button onclick={() => (app.saveError = null)}
        >{app.saveError?.retry ? 'Dismiss' : 'OK'}</button
      >
    </span>
  </div>
{/if}

{#if app.error}
  <main class="screen fail">
    <h1>This phone can't open the log</h1>
    <p>{app.error}</p>
    <p>Private browsing can block local storage. Open the app normally and try again.</p>
  </main>
{:else if app.ready && app.showWelcome}
  <Welcome
    onchoose={(d) => {
      door = d;
      app.passWelcome();
    }}
  />
{:else if app.ready && !app.baby}
  <Setup join={door === 'join'} />
{:else if app.ready && app.baby && app.joining}
  <JoinChoice own={app.baby} to={app.joining} />
{:else if app.ready}
  {@render children()}
{/if}

<style>
  .test-data {
    margin: 0;
    padding: calc(4px + env(safe-area-inset-top)) 12px 4px;
    background: var(--flag);
    color: var(--bg);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-align: center;
    text-transform: uppercase;
  }
  .signing-out {
    margin: 0;
    padding: calc(8px + env(safe-area-inset-top)) 16px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    font-size: 15px;
    text-align: center;
  }
  /* The wipe notice (#85): the sign-out banner's shape, with the OK on the right. */
  .wiped {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
    padding: calc(8px + env(safe-area-inset-top)) 16px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    font-size: 15px;
  }
  .wiped button {
    flex: none;
    min-height: 44px;
    padding: 0 16px;
    font-weight: 600;
  }
  .save-fail {
    position: fixed;
    top: calc(8px + env(safe-area-inset-top));
    left: 12px;
    right: 12px;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 52px;
    padding-left: 14px;
    border: 2px solid var(--flag);
    border-radius: 12px;
    background: var(--panel);
    font-size: 14px;
  }
  .save-fail .acts {
    display: flex;
    align-self: stretch;
  }
  .save-fail button {
    align-self: stretch;
    padding: 0 16px;
    font-weight: 600;
  }
  .fail {
    padding: 48px 24px;
  }
  .fail h1 {
    font: 600 22px var(--sans);
    margin-bottom: 12px;
  }
  .fail p {
    color: var(--dim);
    margin-bottom: 10px;
  }
</style>
