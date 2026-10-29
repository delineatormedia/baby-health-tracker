<script lang="ts">
  import { resolve } from '$app/paths';
  import { app } from '../../lib/ui/app.svelte.ts';
  import { ageDays, countMarks, dayMarks, intake24h } from '../../lib/ui/logic.ts';

  // No evaluator exists yet (packages/insights holds the cited thresholds only), so nothing
  // here is assessed. This screen shows what was logged and says plainly that it is not judged.
  const counts = $derived(countMarks(dayMarks(app.events, app.now)));
  const intake = $derived(intake24h(app.events, app.now));
</script>

<main class="screen fade">
  <header class="top">
    <a class="back" href={resolve('/')}>‹ Readings</a>
    <span class="lab num">Day {ageDays(app.baby!.birthAt, app.now)} · 24 h</span>
  </header>

  <section class="verdict">
    <div class="lab">0 checks evaluated · this phone only</div>
    <h2>Not assessed</h2>
    <p>
      The checks from the clinical reference are not built into the app yet, so it is not judging
      diapers, weight or intake. Nothing here means everything is fine.
    </p>
  </section>

  <div class="sec lab">Logged in the last 24 h</div>
  <div class="list num">
    <div><span>Wet diapers</span><b>{counts.wet}</b></div>
    <div><span>Dirty diapers</span><b>{counts.dirty}</b></div>
    <div><span>Feeds</span><b>{counts.feed}</b></div>
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
  .list {
    margin: 0 16px;
    border-radius: 16px;
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .list div {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 16px;
    height: 52px;
  }
  .list div + div {
    border-top: 1px solid var(--line);
  }
  .list b {
    font: 500 15px var(--mono);
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
  .foot {
    margin: 22px 24px;
    font-size: 13px;
    color: var(--dim);
  }
</style>
