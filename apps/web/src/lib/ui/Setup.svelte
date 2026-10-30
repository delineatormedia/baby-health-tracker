<script lang="ts">
  import { newId } from '@bht/schema';
  import { app } from './app.svelte.ts';
  import SignIn from './SignIn.svelte';
  import { fromLocalInput, toLocalInput } from './time.ts';

  let name = $state('');
  let born = $state(toLocalInput(Date.now()));
  let sex = $state<'female' | 'male' | null>(null);
  /** A second parent's phone joins the household instead of adding the baby again. */
  let other = $state<'join' | 'login' | null>(null);

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
  {#if other}
    <p class="note">
      {other === 'join'
        ? "Make an invite code in Settings on the other parent's phone."
        : 'Use the passkey you made on this phone.'}
    </p>
    <SignIn mode={other} />
    <button class="go2 back" onclick={() => (other = null)}>Add a baby instead</button>
  {:else}
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
    <div class="others">
      <button onclick={() => (other = 'join')}>Join the other parent ›</button>
      <button onclick={() => (other = 'login')}>Sign in ›</button>
    </div>
    <button class="go" disabled={!valid} onclick={add}>
      {name.trim() ? `Add ${name.trim()}` : 'Add baby'}
    </button>
  {/if}
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
  .others {
    display: flex;
    gap: 8px;
    margin: 0 16px 120px;
  }
  .others button {
    flex: 1;
    min-height: 52px;
    border-radius: 12px;
    border: 1px solid var(--line);
    font-size: 17px;
    color: var(--acc);
  }
  .back {
    margin-top: 12px;
  }
  .note {
    margin: 16px 24px;
    font-size: 15px;
    color: var(--dim);
  }
</style>
