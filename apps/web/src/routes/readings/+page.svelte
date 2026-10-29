<script lang="ts">
  import { resolve } from '$app/paths';
  import { CHECK_LABEL, evaluate, URGENCY_TEXT, type CheckResult } from '@bht/insights';
  import { app } from '../../lib/ui/app.svelte.ts';
  import { ageDays, countMarks, dayMarks, intake24h } from '../../lib/ui/logic.ts';
  import Toast from '../../lib/ui/Toast.svelte';
  import {
    COUNT_CHECKS,
    expectedRangeLine,
    fullyLogged,
    loggingStart,
    marksIn,
    reasonText,
    statusText,
  } from '../../lib/ui/readings.ts';

  const counts = $derived(countMarks(dayMarks(app.events, app.now)));
  const intake = $derived(intake24h(app.events, app.now));

  // Re-evaluated once a minute and whenever the events change, always at the real current
  // time: a minute-floored cutoff would leave out a log made earlier this minute.
  const start = $derived(loggingStart(app.setupAt, app.events));
  const minute = $derived(Math.floor(app.now / 60_000));
  const results = $derived.by(() => {
    void minute;
    const now = Date.now();
    return evaluate({
      baby: { birthAt: app.baby!.birthAt, sex: app.baby!.sex },
      events: app.events,
      now: new Date(now).toISOString(),
      // From where logging began, every period counts as fully logged except the ones marked
      // "We missed some" (#24).
      fullyLogged: fullyLogged(app.baby!.birthAt, now, app.events, start),
      // This phone does not sync yet, so its log is the whole log.
      syncedThrough: new Date(now).toISOString(),
    });
  });

  let busy = false;
  async function once(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      app.fail(e);
    } finally {
      busy = false;
    }
  }

  /** "We missed some": the day this check looked at leaves the count checks. */
  const markMissed = (r: CheckResult) =>
    once(() =>
      app.log(
        'missed_logs',
        { start: r.window.start, end: r.window.end },
        'Marked: we missed some',
        {
          occurredAt: r.window.start,
        },
      ),
    );

  /** "We logged everything": takes back every mark on this check's day. */
  const unmark = (r: CheckResult) =>
    once(async () => {
      for (const m of marksIn(app.events, r.window)) await app.store.remove(m.id);
    });
  const flags = $derived(results.filter((r) => r.status === 'flag'));
  const assessed = $derived(results.filter((r) => r.status !== 'not_enough_data').length);
  const inRange = $derived(expectedRangeLine(results));
</script>

<main class="screen fade">
  <header class="top">
    <a class="back" href={resolve('/')}>‹ Readings</a>
    <span class="lab num">Day {ageDays(app.baby!.birthAt, app.now)} · 24 h</span>
  </header>

  {#each flags as r (r.check)}
    {#if r.status === 'flag'}
      <section class="verdict flag">
        {#if COUNT_CHECKS.has(r.check)}
          <!-- A missed log is the likelier cause, so it comes before the pediatrician (#24). -->
          <h2>{r.title}</h2>
          <p>{statusText(r, app.volume)}</p>
          <div class="ask">
            <p class="q">Did you miss logging some?</p>
            <button class="mark" onclick={() => markMissed(r)}>We missed some</button>
          </div>
          <div class="lab then">If not: ! {URGENCY_TEXT[r.urgency]}</div>
        {:else}
          <div class="lab">! {URGENCY_TEXT[r.urgency]}</div>
          <h2>{r.title}</h2>
          <p>{statusText(r, app.volume)}</p>
        {/if}
        <details class="more">
          <summary><span>Why?</span><span aria-hidden="true">›</span></summary>
          <p class="why">{r.why}</p>
          <p class="why">The app can't tell what caused it. Your pediatrician can.</p>
          {@render sources(r)}
        </details>
      </section>
    {/if}
  {:else}
    <section class="verdict">
      <div class="lab">{assessed} of {results.length} checks assessed · this phone only</div>
      <h2>{inRange ?? 'Not enough data to assess'}</h2>
      <p>
        {inRange
          ? 'Only the checks named here were assessed. Total intake is not assessed.'
          : 'Nothing here means everything is fine.'}
      </p>
    </section>
  {/each}

  <div class="toast"><Toast /></div>

  <div class="sec lab">Checks</div>
  <div class="list">
    {#each results as r (r.check)}
      <details>
        <summary>
          <span>{CHECK_LABEL[r.check]}</span>
          <b class:flagged={r.status === 'flag'} class="num">{statusText(r, app.volume)}</b>
        </summary>
        {#if r.status === 'not_enough_data'}
          <p class="why">{reasonText(r, start)}.</p>
          {#if r.reason === 'not_fully_logged' && marksIn(app.events, r.window).length > 0}
            <div><button class="mark" onclick={() => unmark(r)}>We logged everything</button></div>
          {/if}
        {/if}
        {@render sources(r)}
      </details>
    {/each}
  </div>

  <div class="sec lab">Logged in the last 24 h</div>
  <div class="list num">
    <div class="r2"><span>Wet diapers</span><b>{counts.wet}</b></div>
    <div class="r2"><span>Dirty diapers</span><b>{counts.dirty}</b></div>
    <div class="r2"><span>Feeds</span><b>{counts.feed}</b></div>
  </div>

  <section class="row">
    <div class="r">
      <span class="k">Recorded bottle intake</span><b class="num">≈{app.volume(intake.bottleMl)}</b>
    </div>
    <p class="strong">Not enough information to assess total intake</p>
    <p class="lab small">
      ≈{app.volume(intake.bottleMl)} recorded from bottles.{intake.unmeasured > 0
        ? ` ${intake.unmeasured} breastfeed${intake.unmeasured === 1 ? '' : 's'} not measured.`
        : ''} The other phone's logs are not synced yet.
    </p>
  </section>

  <p class="foot">
    If something about your baby worries you, call your pediatrician. The app does not replace that.
  </p>
</main>

{#snippet sources(r: CheckResult)}
  {#if r.citations.length > 0}
    <div class="src">
      <b>Sources</b>
      {#each r.citations as c (c.entryId)}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external source -->
        <a href={c.url} target="_blank" rel="noopener noreferrer">{c.organization}, “{c.title}”</a>
      {/each}
      <span>From docs/CLINICAL_REFERENCE.md</span>
    </div>
  {/if}
{/snippet}

<style>
  .back {
    font: 600 17px var(--sans);
  }
  .verdict {
    margin: 18px 16px 0;
    border-radius: 18px;
    padding: 18px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .verdict h2 {
    font: 600 20px/1.25 var(--sans);
    margin: 8px 0 4px;
  }
  .verdict p {
    font-size: 14px;
    color: var(--dim);
  }
  .verdict + .verdict {
    margin-top: 10px;
  }
  .verdict.flag {
    background: var(--flag-soft);
    border: 1.5px solid var(--flag);
  }
  .verdict.flag .lab {
    color: var(--flag);
  }
  .more {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid color-mix(in srgb, var(--flag) 35%, transparent);
  }
  .more summary {
    display: flex;
    justify-content: space-between;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }
  .more[open] summary span:last-child {
    transform: rotate(90deg);
  }
  .why {
    margin-top: 10px;
    font-size: 14px;
    line-height: 1.45;
  }
  .verdict .why {
    color: var(--ink);
  }
  .src {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 12px 0 4px;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px dashed var(--line);
    font-size: 13px;
    line-height: 1.45;
    color: var(--dim);
  }
  .src b {
    color: var(--ink);
  }
  .src a {
    color: inherit;
  }
  .list {
    margin: 0 16px;
    border-radius: 16px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .list .r2,
  .list summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    min-height: 52px;
  }
  .list summary {
    cursor: pointer;
    list-style: none;
  }
  .list details {
    padding-bottom: 0;
  }
  .list details[open] {
    padding-bottom: 12px;
  }
  .list details > :not(summary) {
    margin-left: 16px;
    margin-right: 16px;
  }
  .list > * + * {
    border-top: 1px solid var(--line);
  }
  .list b {
    font: 500 15px var(--mono);
    text-align: right;
  }
  .list b.flagged {
    color: var(--flag);
  }
  .row {
    margin: 10px 16px 0;
    padding: 16px 18px;
    border-radius: 16px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .r {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .k {
    font-weight: 600;
    font-size: 15px;
  }
  .r b {
    font: 500 15px var(--mono);
  }
  .strong {
    margin-top: 10px;
    font-size: 15px;
    font-weight: 500;
  }
  .small {
    margin-top: 4px;
    text-transform: none;
    letter-spacing: 0.04em;
    font-size: 12px;
  }
  .ask {
    margin-top: 14px;
  }
  .verdict .q {
    font: 600 20px/1.3 var(--sans);
    color: var(--ink);
  }
  .mark {
    display: block;
    box-sizing: border-box;
    width: 100%;
    min-height: 56px;
    margin-top: 10px;
    border-radius: 14px;
    border: 1.5px solid var(--ink);
    background: var(--bg);
    font: 600 20px var(--sans);
  }
  .then {
    margin-top: 14px;
  }
  .toast {
    margin: 10px 16px 0;
  }
  .foot {
    margin: 22px 24px;
    font-size: 13px;
    color: var(--dim);
  }
</style>
