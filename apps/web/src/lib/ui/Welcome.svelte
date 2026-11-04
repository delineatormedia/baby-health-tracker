<script lang="ts">
  /**
   * First launch (#86): the name, what the app is for, and the two doors in. "Start a
   * household" opens Add a baby; "Join with a code" opens the invite-code sign-in. Either
   * door is remembered on this phone, so the screen shows once. Nothing here signs in or
   * writes: the join and passkey logic is unchanged in Setup and SignIn.
   */
  let { onchoose }: { onchoose: (door: 'add' | 'join') => void } = $props();
</script>

<main class="screen fade welcome">
  <div class="brand">
    <!-- The full name lives only here, as an eyebrow (owner, #86). -->
    <p class="eyebrow">Sovereign Medical Technology</p>
    <!-- Two colours split family and product; the gap breaks the word (owner's T3, G1). -->
    <h1 class="wordmark" aria-label="SMT/Baby">
      <span class="smt">smt</span><span class="baby">baby</span>
    </h1>
    <p class="purpose">Feeds, diapers, weight — one log, shared by both parents.</p>
  </div>
  <div class="doors">
    <p class="hint">Joining needs a code from the other parent's phone.</p>
    <button class="go2" onclick={() => onchoose('join')}>Join with a code</button>
    <button class="go" onclick={() => onchoose('add')}>Start a household</button>
  </div>
</main>

<style>
  .welcome {
    display: flex;
    flex-direction: column;
    padding-bottom: calc(30px + var(--safe-b));
  }
  .brand {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: calc(24px + env(safe-area-inset-top, 0px)) 24px 24px;
    text-align: center;
  }
  /* Fine print, not something a parent has to read: the one text under 15 px
     (docs/design/README.md, Type sizes). Still dim on bg, 5.08:1 light / 5.21:1 night. */
  .eyebrow {
    font: 500 11px/1.3 var(--mono);
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--dim);
  }
  .wordmark {
    margin-top: 10px;
    font: 700 46px/1.1 var(--sans);
    letter-spacing: -0.01em;
    color: var(--ink);
  }
  .smt {
    color: var(--acc);
    font-weight: 700;
  }
  .baby {
    margin-left: 0.1em;
    font-weight: 400;
  }
  .purpose {
    margin-top: 16px;
    font-size: 17px;
    color: var(--ink);
    text-wrap: balance;
  }
  .doors {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hint {
    margin: 0 24px 8px;
    font-size: 15px;
    color: var(--dim);
    text-align: center;
    text-wrap: balance;
  }
  .doors .go2 {
    color: var(--ink);
  }
  /* The main action stays in the thumb zone, but in flow: this screen does not scroll. */
  .doors .go {
    position: static;
    width: calc(100% - 32px);
    margin: 0 16px;
  }
  @media (max-width: 359px) {
    .wordmark {
      font-size: 42px;
    }
  }
</style>
