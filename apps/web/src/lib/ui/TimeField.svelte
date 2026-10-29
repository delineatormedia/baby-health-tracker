<script lang="ts">
  import { app, time } from './app.svelte.ts';
  import { fromLocalInput, toLocalInput } from './time.ts';

  /** UTC timestamp to backdate to; null means "now" at the moment of logging. */
  let { at = $bindable(null), prefix = '' }: { at?: string | null; prefix?: string } = $props();

  const label = $derived(at === null ? `Now · ${time(app.now)}` : time(at));
</script>

<!-- A transparent native picker over the label: one tap opens the phone's own wheel. -->
<label class="lab when">
  {prefix}{label} ›
  <input
    type="datetime-local"
    value={toLocalInput(at === null ? app.now : Date.parse(at))}
    max={toLocalInput(app.now)}
    onchange={(e) => {
      const iso = fromLocalInput(e.currentTarget.value);
      at = iso !== null && Date.parse(iso) < app.now - 60_000 ? iso : null;
    }}
    aria-label="Change the time"
  />
</label>

<style>
  .when {
    position: relative;
    padding: 8px 0;
  }
  .when input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
  }
</style>
