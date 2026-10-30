<script lang="ts">
  import { signInFailure } from '../data/account.ts';
  import { app } from './app.svelte.ts';
  import { inviteCode } from './session.ts';

  /**
   * Passkey sign-in (#5 step 3). `register` creates the household around this phone's baby,
   * `join` uses the other parent's invite code, and `login` uses a passkey this phone has.
   */
  let { mode, onDone }: { mode: 'register' | 'join' | 'login'; onDone?: () => void } = $props();

  let name = $state('');
  let code = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const normalized = $derived(inviteCode(code));
  const valid = $derived(
    mode === 'login' || (name.trim().length > 0 && (mode === 'register' || normalized !== null)),
  );
  const label = $derived(
    mode === 'register'
      ? 'Create with a passkey'
      : mode === 'join'
        ? 'Join with a passkey'
        : 'Sign in with a passkey',
  );

  async function go() {
    if (!valid || busy || app.transition === 'signOut') return;
    busy = true;
    error = null;
    try {
      const displayName = name.trim();
      await app.signIn((account, signal) => {
        if (mode === 'login') return account.login(signal);
        if (mode === 'join') return account.join({ code: normalized!, displayName }, signal);
        const baby = app.baby;
        if (!baby) throw new Error('Add a baby first.');
        const { householdId, ...rest } = baby;
        return account.register({ householdId, displayName, baby: rest }, signal);
      });
      onDone?.();
    } catch (e) {
      error = signInFailure(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="sign-in">
  {#if mode === 'join'}
    <label class="field">
      <span class="lab">Invite code</span>
      <input
        bind:value={code}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        placeholder="From the other parent's phone"
      />
    </label>
  {/if}
  {#if mode !== 'login'}
    <label class="field">
      <span class="lab">Your name</span>
      <input bind:value={name} autocomplete="given-name" maxlength="60" />
    </label>
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  <button class="go2 primary" disabled={!valid || busy || app.transition === 'signOut'} onclick={go}
    >{busy ? 'Waiting for passkey…' : label}</button
  >
</div>

<style>
  .sign-in {
    margin-top: 12px;
  }
  .field {
    display: block;
    margin: 0 16px 8px;
    padding: 10px 16px 12px;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--line);
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
  .primary {
    border: none;
    background: var(--acc);
    color: var(--acc-ink);
    font-weight: 600;
  }
  .primary:disabled {
    opacity: 0.5;
  }
  .err {
    margin: 4px 24px 8px;
    font-size: 15px;
    color: var(--flag);
  }
</style>
