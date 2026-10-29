<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { app } from './app.svelte.ts';
</script>

<div class="slot" aria-live="polite">
  {#if app.toast}
    {@const t = app.toast}
    <div class="toast in">
      <!-- Each " · " part stays whole, so a line only breaks between parts (#49). -->
      <span class="msg"
        >{#each t.text.split(' · ') as part, i (i)}{i > 0 ? ' · ' : ''}<span class="part"
            >{part}</span
          >{/each}</span
      >
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
  /* Noticeable, not alarming (#49): an accent edge, a shadow and a short rise on arrival. The
     actions wrap under the message only when both don't fit on one line. */
  .toast {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 12px;
    min-height: 52px;
    padding: 0 0 0 14px;
    border: 1px solid var(--line);
    border-left: 5px solid var(--acc);
    border-radius: 12px;
    background: var(--panel);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.14);
  }
  .msg {
    flex: 1 1 auto;
    padding: 12px 0;
    font: 500 17px/1.3 var(--sans);
  }
  .part {
    display: inline-block;
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
  @media (prefers-reduced-motion: no-preference) {
    .in {
      animation: rise 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(16px);
      }
    }
  }
</style>
