<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { app } from './app.svelte.ts';
</script>

<div class="slot" aria-live="polite">
  {#if app.toast}
    {@const t = app.toast}
    <div class="toast fade">
      <span class="msg">{t.text}</span>
      <span class="acts">
        {#if t.edit}
          {@const edit = t.edit}
          <button
            onclick={() => {
              // Read the path first: dismissing clears the toast these consts derive from.
              const path = resolve(edit.path);
              app.dismissToast();
              void goto(path);
            }}>{edit.label}</button
          >
        {/if}
        {#if t.undo}
          <button onclick={() => void t.undo?.()}>Undo</button>
        {/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .slot {
    min-height: 52px;
  }
  .toast {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 12px;
    min-height: 52px;
    padding: 0 0 0 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    font-size: 15px;
  }
  /* The actions wrap under the message when 20 px labels leave it too narrow (320 px). */
  .msg {
    flex: 1 1 9em;
    padding: 8px 0;
    font-size: 17px;
  }
  .acts {
    display: flex;
    align-self: stretch;
    min-height: 52px;
    margin-left: auto;
  }
  button {
    align-self: stretch;
    padding: 0 14px;
    font: 600 20px var(--sans);
    color: var(--acc);
    white-space: nowrap;
  }
  button + button {
    border-left: 1px solid var(--line);
  }
</style>
