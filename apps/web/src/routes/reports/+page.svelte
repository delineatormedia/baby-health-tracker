<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { formatWeight, fromMl } from '@bht/schema';
  import { app } from '../../lib/ui/app.svelte.ts';
  import Glyph from '../../lib/ui/Glyph.svelte';
  import Timeline from '../../lib/ui/Timeline.svelte';
  import {
    addDays,
    averages,
    clockChange,
    clockText,
    hourText,
    compareDay,
    dayMedium,
    dayShort,
    dayStartText,
    dayState,
    dayTitle,
    dayWindow,
    eventsIn,
    localZone,
    markedMissing,
    midnightIn,
    mondayOf,
    monthTitle,
    parseYmd,
    reportDay,
    rowText,
    sameDay,
    tally,
    wall,
    weekTitle,
    windowHours,
    windowText,
    ymdKey,
    type Ymd,
  } from '../../lib/ui/reports.ts';

  // Reports (#21): read-only. Editing an event stays in History; nothing here opens an editor.
  type View = 'day' | 'week' | 'month';
  const VIEWS: [View, string][] = [
    ['day', 'Day'],
    ['week', 'Week'],
    ['month', 'Month'],
  ];

  const tz = localZone();
  const dayStart = $derived(app.prefs.dayStart);
  const today = $derived(reportDay(app.now, dayStart, tz));
  const birthAt = $derived(Date.parse(app.baby!.birthAt));
  const birthDay = $derived(reportDay(birthAt, dayStart, tz));
  /** The calendar date of birth, for "Since birth, Oct 17" (its report day can be the 16th). */
  const birthDate = $derived(wall(birthAt, tz));

  const view = $derived<View>(
    (['day', 'week', 'month'] as const).find((v) => v === page.url.searchParams.get('view')) ??
      'day',
  );
  /** The picked date, held between birth and today. */
  const date = $derived.by(() => {
    const d = parseYmd(page.url.searchParams.get('date')) ?? today;
    if (compareDay(d, today) > 0) return today;
    return compareDay(d, birthDay) < 0 ? birthDay : d;
  });

  function open(v: View, d: Ymd, push = false) {
    void goto(resolve(`/reports?view=${v}&date=${ymdKey(d)}`), {
      replaceState: !push,
    });
  }

  const day = (d: Ymd) => {
    const win = dayWindow(d, dayStart, tz);
    const events = eventsIn(app.events, win.start, win.end).filter(
      (e) => Date.parse(e.occurredAt) <= app.now,
    );
    return {
      date: d,
      win,
      events,
      tally: tally(events),
      state: dayState(win, app.now),
      missing: markedMissing(app.events, win.start, win.end),
    };
  };

  // Day ------------------------------------------------------------------------------------
  const dDay = $derived(day(date));
  const midnight = $derived(midnightIn(dDay.win, tz));
  const change = $derived(clockChange(dDay.win, tz));
  /** "2 AM": the wall-clock hour that did not happen when the clocks went forward. */
  const skipped = $derived(
    change && !change.back
      ? dayStartText(((wall(change.at, tz).h + 23) % 24) * 60).replace('Midnight', '12 AM')
      : '',
  );
  const rows = $derived.by(() => {
    let afterMidnight = false;
    let afterChange = false;
    return dDay.events.map((e) => {
      const t = Date.parse(e.occurredAt);
      const dividers: string[] = [];
      if (midnight !== null && !afterMidnight && t >= midnight) {
        afterMidnight = true;
        dividers.push(`After midnight · ${dayMedium(addDays(date, 1))}`);
      }
      if (change && !afterChange && t >= change.at) {
        afterChange = true;
        dividers.push(
          change.back
            ? `Clocks went back · ${hourText(change.at, tz)} again`
            : `Clocks went forward · no ${skipped}`,
        );
      }
      const text = rowText(e, app.volume);
      return {
        e,
        t,
        dividers,
        text: { ...text, name: glue(text.name), detail: glue(text.detail) },
      };
    });
  });

  /** Rows wrap between phrases, never inside "60 mL", "15 min" or "R 40 mL". */
  const glue = (s: string) =>
    s.replace(/(\d) (?=[a-zA-Z])/g, '$1\u00a0').replace(/\b([LR]) (?=\d)/g, '$1\u00a0');

  // Week -----------------------------------------------------------------------------------
  const monday = $derived(mondayOf(date));
  const week = $derived([0, 1, 2, 3, 4, 5, 6].map((i) => day(addDays(monday, i))));
  const weekAvg = $derived(averages(week, birthAt, app.now));

  // Month ----------------------------------------------------------------------------------
  const first = $derived({ y: date.y, m: date.m, d: 1 });
  const monthDays = $derived.by(() => {
    const out: Ymd[] = [];
    for (let d = first; d.m === first.m; d = addDays(d, 1)) out.push(d);
    return out;
  });
  const month = $derived(
    monthDays.map((d) => (compareDay(d, birthDay) < 0 || compareDay(d, today) > 0 ? null : day(d))),
  );
  const monthAvg = $derived(
    averages(
      month.filter((x) => x !== null),
      birthAt,
      app.now,
    ),
  );
  const lead = $derived((new Date(Date.UTC(first.y, first.m - 1, 1)).getUTCDay() + 6) % 7);

  // Stepper --------------------------------------------------------------------------------
  const step = $derived.by(() => {
    if (view === 'day')
      return {
        title: dayTitle(date),
        sub: windowText(dDay.win, dayStart, tz),
        prev: addDays(date, -1),
        next: addDays(date, 1),
        lastOk: addDays(date, -1),
      };
    if (view === 'week')
      return {
        title: weekTitle(monday),
        sub: 'Mon to Sun',
        prev: addDays(monday, -7),
        next: addDays(monday, 7),
        lastOk: addDays(monday, -1),
      };
    const prev = addDays(first, -1);
    return {
      title: monthTitle(first),
      sub: compareDay(birthDay, first) >= 0 ? `Since birth, ${dayMedium(birthDate).slice(4)}` : '',
      prev: { ...prev, d: 1 },
      next: addDays(first, 32),
      lastOk: prev,
    };
  });
  /** Back stops at birth; forward stops at the current period. */
  const canPrev = $derived(compareDay(step.lastOk, birthDay) >= 0);
  const canNext = $derived.by(() => {
    if (view === 'day') return compareDay(date, today) < 0;
    if (view === 'week') return compareDay(addDays(monday, 7), today) <= 0;
    return compareDay({ ...step.next, d: 1 }, today) <= 0;
  });
  const prevDate = $derived(
    view === 'month' ? step.prev : compareDay(step.prev, birthDay) < 0 ? birthDay : step.prev,
  );
  const nextDate = $derived(
    view === 'month'
      ? { ...step.next, d: 1 }
      : compareDay(step.next, today) > 0
        ? today
        : step.next,
  );

  const per = (n: number) => String(n);
  const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);
</script>

<main class="screen fade reports">
  <header class="top">
    <a class="back" href={resolve('/')}>‹ Home</a>
    <span class="rl">Day starts {dayStart === 0 ? 'midnight' : dayStartText(dayStart)}</span>
  </header>

  <div class="seg" role="group" aria-label="Period">
    {#each VIEWS as [v, label] (v)}
      <button aria-pressed={view === v} onclick={() => open(v, date)}>{label}</button>
    {/each}
  </div>

  <div class="stepper">
    <button
      class="arr"
      aria-label="Previous {view}"
      disabled={!canPrev}
      onclick={() => open(view, prevDate)}>‹</button
    >
    <!-- A transparent native picker over the period, like TimeRow: one tap opens the wheel. -->
    <label class="period">
      <b>{step.title}</b>
      <!-- "7:30 AM / to 7:30 AM Sun / · 25 h": wraps between whole phrases, never inside a time. -->
      {#if step.sub}<span class="rl"
          >{#each step.sub.split(/ (?=to |· )/) as part, i (i)}{i ? ' ' : ''}<span class="nw"
              >{part}</span
            >{/each}</span
        >{/if}
      <input
        type="date"
        aria-label="Pick a date"
        value={ymdKey(date)}
        min={ymdKey(birthDay)}
        max={ymdKey(today)}
        onchange={(e) => {
          const d = parseYmd(e.currentTarget.value);
          if (d) open(view, d);
        }}
      />
    </label>
    <button
      class="arr"
      aria-label="Next {view}"
      disabled={!canNext}
      onclick={() => open(view, nextDate)}>›</button
    >
  </div>

  {#if view === 'day'}
    {@const c = dDay.tally}
    {@const oz = app.prefs.volume === 'oz'}
    <div class="sum">
      <div>
        <span class="rl">Diapers</span>
        <div class="n num">{c.diapers}</div>
        <div class="sub">
          <Glyph kind="wet" /><b>{c.wet}</b> wet<br /><Glyph kind="dirty" /><b>{c.dirty}</b> dirty
        </div>
      </div>
      <div>
        <span class="rl">Feeds</span>
        <div class="n num">{c.breast + c.bottle}</div>
        <div class="sub">
          <Glyph kind="feed" /><b>{c.breast}</b> breast<br /><Glyph kind="bottle" /><b>{c.bottle}</b
          > bottle
        </div>
      </div>
      <div>
        <span class="rl">Bottle</span>
        <div class="n num">{oz ? fromMl(c.bottleMl, 'oz').toFixed(1) : Math.round(c.bottleMl)}</div>
        <div class="sub">
          <b>{oz ? 'oz' : 'mL'}</b> total{#if app.prefs.volume === 'both'}<br /><b
              >{fromMl(c.bottleMl, 'oz').toFixed(1)}</b
            > oz{/if}
        </div>
      </div>
    </div>
    {#each c.weights as w (w.id)}
      <div class="wcard">
        <span class="rl">Weight</span><b class="num">{formatWeight(w.data.grams, 'kg')}</b><span
          class="sub"
          >{formatWeight(w.data.grams, 'lb_oz')} · {w.data.source === 'clinic'
            ? 'Clinic'
            : 'Home scale'}</span
        >
      </div>
    {/each}
    <div class="strip">
      <Timeline events={dDay.events} win={dDay.win} {dayStart} {tz} now={app.now} />
    </div>
    {#if change}
      <p class="note">
        {change.back
          ? `Clocks went back an hour, so ${hourText(change.at, tz)} to ${hourText(change.at + 3_600_000, tz)} happened twice. The shaded hour is the second one.`
          : `Clocks went forward an hour (solid line). There was no ${skipped} hour.`}
      </p>
    {/if}
    {#if dDay.state === 'today'}
      <p class="note">Today so far.</p>
    {/if}
    {#if dDay.missing}
      <p class="note miss">
        <i class="g g-miss"></i>You marked missing logs for this day. The totals count only what was
        logged.
      </p>
    {/if}
    <ol class="list">
      {#each rows as r (r.e.id)}
        {#each r.dividers as d (d)}
          <li class="divider rl">{d}</li>
        {/each}
        <li class="rr" class:w={r.e.type === 'weight'}>
          <span class="t num">{clockText(r.t, tz)}</span>
          <span class="k"
            >{#if r.text.glyph}<Glyph kind={r.text.glyph} />{:else}<i class="g"></i>{/if}{r.text
              .name}{#if r.text.detail}<small>{r.text.detail}</small>{/if}</span
          >
        </li>
      {:else}
        <li class="empty">Nothing logged{dDay.state === 'today' ? ' yet today' : ' this day'}.</li>
      {/each}
    </ol>
  {:else if view === 'week'}
    {#if weekAvg}
      <p class="avg">
        A day on average{weekAvg.days < 7
          ? ` (${weekAvg.days} full ${weekAvg.days === 1 ? 'day' : 'days'})`
          : ''}: <b>{per(weekAvg.diapers)}</b>
        {plural(weekAvg.diapers, 'diaper')}, <b>{per(weekAvg.feeds)}</b>
        {plural(weekAvg.feeds, 'feed')},
        <b>{app.volume(weekAvg.bottleMl)}</b> bottle.
      </p>
    {/if}
    <div class="wk">
      {#each week as d (ymdKey(d.date))}
        {@const hours = windowHours(d.win)}
        {@const tag = [
          d.state === 'today' ? 'so far' : '',
          hours !== 24 ? `${hours} h` : '',
          d.missing ? 'missing logs' : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        {#if d.state === 'future' || compareDay(d.date, birthDay) < 0}
          <div class="row fut">
            <span class="h"><b>{dayShort(d.date)}</b><span class="sub">Not yet</span></span>
          </div>
        {:else}
          <button class="row" onclick={() => open('day', d.date, true)}>
            <span class="h"
              ><b
                >{dayShort(d.date)}{#if d.missing}<i class="g g-miss mk"></i>{/if}{#if tag}<span
                    class="tag">{tag}</span
                  >{/if}</b
              ><!-- At 320 px the line wraps between counts, never between a number and its unit. -->
              <span class="sub"
                ><span class="nw"><b>{d.tally.diapers}</b> {plural(d.tally.diapers, 'diaper')}</span
                >
                ·
                <span class="nw"
                  ><b>{d.tally.breast + d.tally.bottle}</b>
                  {plural(d.tally.breast + d.tally.bottle, 'feed')}</span
                >
                · <span class="nw"><b>{app.volume(d.tally.bottleMl)}</b></span></span
              ></span
            >
            <Timeline events={d.events} win={d.win} {dayStart} {tz} now={app.now} mini />
          </button>
        {/if}
      {/each}
    </div>
  {:else}
    {#if monthAvg}
      <p class="avg">
        A day on average: <b>{per(monthAvg.diapers)}</b>
        {plural(monthAvg.diapers, 'diaper')}, <b>{per(monthAvg.feeds)}</b>
        {plural(monthAvg.feeds, 'feed')}, <b>{app.volume(monthAvg.bottleMl)}</b> bottle.
      </p>
    {/if}
    <p class="note">
      <Glyph kind="feed" /> feeds ·
      <span class="pair"><i class="wet"></i><i class="dirty"></i></span>
      diapers · outlined: today so far · <i class="g g-miss"></i> missing logs marked
    </p>
    <div class="cal">
      {#each ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as w, i (i)}
        <div class="wd" aria-hidden="true">{w}</div>
      {/each}
      {#each Array.from({ length: lead }, (_x, i) => i) as i (i)}
        <div></div>
      {/each}
      {#each month as d, i (i)}
        {#if d === null}
          <div class="c x"><b>{i + 1}</b></div>
        {:else}
          <button
            class="c"
            class:today={sameDay(d.date, today)}
            aria-label="{dayTitle(d.date)}: {d.tally.breast + d.tally.bottle} feeds, {d.tally
              .diapers} diapers{d.missing ? ', missing logs marked' : ''}"
            onclick={() => open('day', d.date, true)}
          >
            <b>{d.date.d}</b>
            {#if d.missing}<i class="g g-miss mk"></i>{/if}
            <span><Glyph kind="feed" />{d.tally.breast + d.tally.bottle}</span>
            <span
              ><span class="pair"><i class="wet"></i><i class="dirty"></i></span>{d.tally
                .diapers}</span
            >
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</main>

<style>
  /* Reports follow the #20 type rules: anything tappable is 20 px, no text under 15 px, and
     secondary text uses --text-dim so it reaches 4.5:1 in both themes. */
  .reports {
    padding-bottom: calc(40px + var(--safe-b));
  }
  .rl {
    font: 500 15px/1.3 var(--mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .back {
    font-size: 20px !important;
    font-weight: 500 !important;
    color: var(--acc) !important;
  }
  .seg button {
    font-size: 20px;
  }
  .stepper {
    position: relative;
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr) 52px;
    gap: 8px;
    align-items: center;
    margin: 14px 16px 0;
  }
  .arr {
    height: 52px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: var(--panel);
    font: 500 24px var(--sans);
  }
  .arr:disabled {
    background: none;
    color: var(--text-dim);
    opacity: 1;
  }
  .period {
    display: block;
    min-height: 52px;
    text-align: center;
  }
  .period b {
    display: block;
    font: 600 20px var(--sans);
  }
  .period .rl {
    display: block;
    margin-top: 4px;
  }
  .period {
    position: relative;
    cursor: pointer;
  }
  .period input {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
  }
  .sum {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 14px 16px 0;
  }
  .sum > div,
  .wcard,
  .strip {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
  }
  .sum > div {
    padding: 10px 12px 12px;
  }
  .n {
    font: 300 36px/1.1 var(--sans);
    margin: 4px 0;
  }
  .nw {
    white-space: nowrap;
  }
  .sub {
    font: 400 15px/1.35 var(--sans);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .sub b {
    font-weight: 500;
    color: var(--ink);
  }
  .wcard {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    margin: 8px 16px 0;
    padding: 10px 12px;
  }
  .wcard b {
    font: 300 24px/1.1 var(--sans);
    white-space: nowrap;
  }
  .strip {
    margin: 8px 16px 0;
    padding: 10px 12px 6px;
  }
  .note {
    margin: 10px 24px 0;
    font: 400 15px/1.45 var(--sans);
    color: var(--text-dim);
  }
  .list {
    list-style: none;
    margin-top: 6px;
  }
  .rr {
    display: grid;
    grid-template-columns: 84px 1fr;
    gap: 10px;
    align-items: center;
    padding: 9px 24px;
    border-bottom: 1px solid var(--line);
  }
  .rr .t {
    font: 500 15px var(--mono);
    color: var(--text-dim);
    text-align: right;
  }
  .rr .k {
    font-size: 17px;
  }
  .rr.w small {
    display: block;
    margin: 2px 0 0 20px;
  }
  .rr small {
    margin-left: 6px;
    font-size: 15px;
    color: var(--text-dim);
  }
  .divider {
    margin: 14px 24px 2px;
  }
  .empty {
    margin: 18px 24px;
    font-size: 17px;
    color: var(--text-dim);
  }
  .avg {
    margin: 14px 24px 0;
    font-size: 17px;
    line-height: 1.4;
  }
  .avg b {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .wk {
    margin: 12px 16px 0;
    border-radius: 16px;
    background: var(--panel);
    border: 1px solid var(--line);
    overflow: hidden;
  }
  .row {
    display: block;
    width: 100%;
    padding: 10px 14px 8px;
    text-align: left;
  }
  .row + .row {
    border-top: 1px solid var(--line);
  }
  .row .h {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
  }
  .row .h > b {
    font: 600 20px var(--sans);
    white-space: nowrap;
  }
  .tag {
    display: block;
    font: 400 15px/1.3 var(--sans);
    color: var(--text-dim);
  }
  .fut .h > b {
    color: var(--text-dim);
    font-weight: 500;
  }
  .cal {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 4px;
    margin: 10px 12px 0;
  }
  .wd {
    text-align: center;
    font: 500 15px var(--mono);
    color: var(--text-dim);
  }
  .c {
    height: 74px;
    border-radius: 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 5px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-start;
    text-align: left;
  }
  .c b {
    font: 500 20px/1 var(--sans);
    font-variant-numeric: tabular-nums;
  }
  .c span {
    display: flex;
    align-items: center;
    gap: 4px;
    font: 400 15px/1.15 var(--sans);
    font-variant-numeric: tabular-nums;
  }
  .c {
    position: relative;
  }
  .c .mk {
    position: absolute;
    top: 5px;
    right: 4px;
    width: 10px;
    height: 10px;
    /* Keeps the hatched mark at 12 px in its 10 px corner, as before the 16 px box (#53). */
    --g: 14.4px;
  }
  .c.x {
    background: none;
    border-color: transparent;
  }
  .c.x b {
    font-weight: 400;
    color: var(--text-dim);
  }
  .c.today {
    border: 2px solid var(--ink);
  }
  /* Glyph's svg is the child component's: the margins reach it through :global. */
  .reports :global(.g) {
    margin-right: 8px;
  }
  .sub :global(.g) {
    margin-right: 5px;
  }
  .c :global(.g) {
    margin-right: 0;
  }
  .row .mk {
    margin: 0 0 0 8px;
    vertical-align: 0;
  }
  .note.miss {
    color: var(--ink);
  }
  .pair {
    display: inline-flex;
    gap: 1px;
    align-items: center;
  }
  .pair i {
    display: inline-block;
    width: 6px;
    height: 6px;
  }
  .pair .wet {
    background: var(--wet);
    border-radius: 50%;
  }
  .pair .dirty {
    background: var(--dirty);
  }
</style>
