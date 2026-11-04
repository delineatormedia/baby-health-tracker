<script lang="ts">
  import { resolve } from '$app/paths';
  import { CHECK_LABEL, evaluate, URGENCY_TEXT, type CheckResult } from '@bht/insights';
  import { app } from '../../lib/ui/app.svelte.ts';
  import { ageDays, countMarks, dayMarks, intake24h } from '../../lib/ui/logic.ts';
  import Toast from '../../lib/ui/Toast.svelte';
  import { lateIn, lateText } from '../../lib/ui/late.ts';
  import {
    COUNT_CHECKS,
    expectedRangeLine,
    fullyLogged,
    loggingStart,
    marksIn,
    countWithoutLabel,
    reasonText,
    statusText,
    vouchesIn,
    waitingOnPhones,
    waitingText,
  } from '../../lib/ui/readings.ts';

  const counts = $derived(countMarks(dayMarks(app.events, app.now)));
  const intake = $derived(intake24h(app.events, app.now));

  // Re-evaluated once a minute and whenever the events change, always at the real current
  // time: a minute-floored cutoff would leave out a log made earlier this minute.
  const start = $derived(loggingStart(app.setupAt, app.events));
  const minute = $derived(Math.floor(app.now / 60_000));
  const clock = $derived.by(() => {
    void minute;
    return { wall: Date.now(), mono: performance.now() };
  });
  const results = $derived.by(() => {
    const now = clock.wall;
    const synced = app.syncedSpans(now, clock.mono);
    return evaluate({
      baby: { birthAt: app.baby!.birthAt, sex: app.baby!.sex },
      events: app.events,
      now: new Date(now).toISOString(),
      // From where logging began, every period counts as fully logged except the ones marked
      // "We missed some" (#24).
      fullyLogged: fullyLogged(app.baby!.birthAt, now, app.events, start),
      // A window is assessed once every other phone has uploaded what it recorded in it, or a
      // parent counted without it (step 3b). A phone that is not signed in holds the whole log.
      synced: synced.map(([s, e]) => ({ start: isoOrNull(s), end: isoOrNull(e) })),
    });
  });
  const isoOrNull = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  /** The phones a check's window waits on. */
  const waitingFor = (r: CheckResult) =>
    app.waitingOnWindow(
      Date.parse(r.window.start),
      Date.parse(r.window.end),
      clock.wall,
      clock.mono,
    );
  const notSynced = (r: CheckResult) =>
    r.status === 'not_enough_data' && r.reason === 'not_synced' && app.account !== null;
  /** Why a check waits on the other phones, or its usual reason. */
  const why = (r: CheckResult) =>
    notSynced(r) ? waitingText(waitingFor(r)) : reasonText(r, start);
  /**
   * "Updated: entries from Sam’s phone arrived late", for a window holding entries that came in
   * after it was assessed; null otherwise, and while the check waits on a phone again.
   */
  const updated = (r: CheckResult) => {
    if (notSynced(r)) return null;
    const late = lateIn(app.late, Date.parse(r.window.start), Date.parse(r.window.end));
    return late.length > 0 ? lateText(late, app.devices) : null;
  };
  /** The intake note's "not synced yet" line: only while a check is waiting on a phone. */
  const waiting = $derived(app.account !== null && waitingOnPhones(results, waitingFor));

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
      app.log('missed_logs', { start: r.window.start, end: r.window.end }, 'Missed some', {
        occurredAt: r.window.start,
        day: `Day ${ageDays(app.baby!.birthAt, Date.parse(r.window.start))}`,
      }),
    );

  /**
   * "Count without Sam’s phone" (step 3b): a mark from Sam's phone's converted watermark, or
   * from the start of time when there is none, to now. One per waiting phone, one Undo.
   */
  const countWithout = (r: CheckResult) =>
    once(async () => {
      const wall = Date.now();
      const mono = performance.now();
      const phones = waitingFor(r);
      for (const d of phones) {
        const from = app.coveredThrough(d, wall, mono);
        await app.log(
          'count_without',
          {
            deviceId: d.deviceId,
            start: from === null ? null : new Date(from).toISOString(),
            end: new Date(wall).toISOString(),
          },
          `Counted without ${d.memberName}’s phone`,
        );
      }
    });

  /** "Wait for Sam’s phone": takes back the Count-without marks on this check's window. */
  const unvouch = (r: CheckResult) =>
    once(async () => {
      for (const m of vouchesIn(app.events, r.window)) await app.store.remove(m.id);
    });

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
          {@render late(r)}
          <div class="ask">
            <p class="q">Did you miss logging some?</p>
            <button class="mark" onclick={() => markMissed(r)}>We missed some</button>
          </div>
          <div class="lab then">If not: ! {URGENCY_TEXT[r.urgency]}</div>
        {:else}
          <div class="lab">! {URGENCY_TEXT[r.urgency]}</div>
          <h2>{r.title}</h2>
          <p>{statusText(r, app.volume)}</p>
          {@render late(r)}
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
      <div class="lab">
        {assessed} of {results.length} checks assessed
      </div>
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
        {@render late(r)}
        {#if r.status === 'not_enough_data'}
          <p class="why">{why(r)}.</p>
          {#if r.reason === 'not_fully_logged' && marksIn(app.events, r.window).length > 0}
            <div><button class="mark" onclick={() => unmark(r)}>We logged everything</button></div>
          {/if}
          {#if notSynced(r) && waitingFor(r).length > 0}
            <div>
              <button class="mark" onclick={() => countWithout(r)}>
                {countWithoutLabel(waitingFor(r))}
              </button>
            </div>
          {/if}
        {/if}
        {#if app.account && vouchesIn(app.events, r.window).length > 0}
          <p class="why">Counted without a phone that had not synced.</p>
          <div><button class="mark" onclick={() => unvouch(r)}>Wait for the phone</button></div>
        {/if}
        {@render sources(r)}
      </details>
    {/each}
  </div>

  <div class="sec lab">Logged in the last 24 h</div>
  <div class="list num">
    <div class="r2"><span>Wet diapers</span><b>{counts.wet}</b></div>
    <div class="r2"><span>Dirty diapers</span><b>{counts.dirty}</b></div>
    <div class="r2"><span>Feeds</span><b>{counts.feed + counts.bottle}</b></div>
  </div>

  <section class="row">
    <div class="r">
      <span class="k">Recorded bottle intake</span><b class="num">≈{app.volume(intake.bottleMl)}</b>
    </div>
    <p class="strong">Not enough information to assess total intake</p>
    <p class="lab small">
      ≈{app.volume(intake.bottleMl)} recorded from bottles.{intake.unmeasured > 0
        ? ` ${intake.unmeasured} breastfeed${intake.unmeasured === 1 ? '' : 's'} not measured.`
        : ''}{waiting ? ' Some logs from the other phones are not synced yet.' : ''}
    </p>
  </section>

  <p class="foot">
    If something about your baby worries you, call your pediatrician. The app does not replace that.
  </p>
</main>

{#snippet late(r: CheckResult)}
  {@const text = updated(r)}
  {#if text}
    <p class="why">{text}.</p>
  {/if}
{/snippet}

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
    font-size: 17px;
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
    font-size: 20px;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }
  .more[open] summary span:last-child {
    transform: rotate(90deg);
  }
  .why {
    margin-top: 10px;
    font-size: 17px;
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
    font-size: 15px;
    line-height: 1.45;
    color: var(--dim);
  }
  .src b {
    color: var(--ink);
  }
  .src a {
    color: inherit;
    font-size: 20px;
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
    font-size: 20px;
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
    font-size: 17px;
  }
  .r b {
    font: 500 17px var(--mono);
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
    font-size: 15px;
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
    font-size: 15px;
    color: var(--dim);
  }
</style>
