<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { app } from './app.svelte.ts';
</script>

<div class="slot" aria-live="polite">
  {#if app.toast}
    {@const t = app.toast}
    <div class="toast fade">
      <span>{t.text}</span>
      {#if t.edit}
        {@const edit = t.edit}
        <button
          onclick={() => {
            app.dismissToast();
            void goto(resolve(edit.path));
          }}>{edit.label}</button
        >
      {/if}
      {#if t.undo}
        <button onclick={() => void t.undo?.()}>Undo</button>
      {/if}
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
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 0 0 0 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    font-size: 14px;
  }
  span {
    flex: 1;
    padding: 8px 0;
  }
  button {
    align-self: stretch;
    padding: 0 14px;
    font-weight: 600;
    white-space: nowrap;
  }
  button + button {
    border-left: 1px solid var(--line);
  }
</style>
