<script lang="ts">
  import { newId } from '@bht/schema';
  import { app } from './app.svelte.ts';
  import { fromLocalInput, toLocalInput } from './time.ts';

  let name = $state('');
  let born = $state(toLocalInput(Date.now()));
  let sex = $state<'female' | 'male' | null>(null);

  const bornAt = $derived(fromLocalInput(born));
  const valid = $derived(
    name.trim().length > 0 && bornAt !== null && Date.parse(bornAt) <= Date.now() && sex !== null,
  );

  function add() {
    if (!valid || !bornAt || !sex) return;
    app.setBaby({ id: newId(), householdId: newId(), name: name.trim(), birthAt: bornAt, sex });
  }
</script>

<main class="screen fade">
  <header class="top"><h1>Add a baby</h1></header>
  <div class="fields">
    <label class="field">
      <span class="lab">Name</span>
      <input bind:value={name} autocomplete="off" maxlength="100" />
    </label>
    <label class="field">
      <span class="lab">Born</span>
      <input type="datetime-local" bind:value={born} max={toLocalInput(Date.now())} />
    </label>
  </div>
  <div class="sec lab">Sex</div>
  <div class="opts two">
    <button aria-pressed={sex === 'female'} onclick={() => (sex = 'female')}>Female</button>
    <button aria-pressed={sex === 'male'} onclick={() => (sex = 'male')}>Male</button>
  </div>
  <p class="note">Saved on this phone. Growth standards are sex-specific, so readings use it.</p>
  <button class="go" disabled={!valid} onclick={add}>
    {name.trim() ? `Add ${name.trim()}` : 'Add baby'}
  </button>
</main>

<style>
  .fields {
    margin-top: 26px;
  }
  .field {
    display: block;
    margin: 0 16px;
    padding: 10px 16px 12px;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .field + .field {
    margin-top: 8px;
  }
  .field input {
    display: block;
    width: 100%;
    margin-top: 4px;
    border: none;
    background: none;
    font-size: 20px;
    outline: none;
    min-height: 32px;
  }
  .two {
    grid-template-columns: 1fr 1fr;
  }
  .note {
    margin: 16px 24px;
    font-size: 15px;
    color: var(--dim);
  }
</style>
