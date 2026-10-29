<script lang="ts">
  import { settingsLine, type SyncView } from './sync.ts';

  let { signedIn, status, error, rejected }: SyncView & { rejected: number } = $props();
</script>

<p class="note" class:flag={signedIn && status === 'offline'} role="status">
  {settingsLine({ signedIn, status, error })}
</p>
{#if rejected > 0}
  <p class="note refused" role="status">
    <b>{rejected} {rejected === 1 ? 'entry' : 'entries'} the server refused.</b> They are still on
    this phone and were not shared.
  </p>
{/if}

<style>
  .note {
    margin: 10px 24px 0;
    font-size: 15px;
    color: var(--text-dim);
  }
  .note.flag {
    color: var(--ink);
  }
  .note b {
    color: var(--ink);
    font-weight: 500;
  }
</style>
