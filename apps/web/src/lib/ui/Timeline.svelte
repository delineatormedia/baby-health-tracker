<script lang="ts">
  import type { BabyEvent } from '@bht/schema';
  import { clockChange, hourText, midnightIn, ticks, type DayWindow } from './reports.ts';

  // A report day in the dial's shapes. x is real elapsed time, so a 25 h day has 25 equal
  // hours. Feed bars (as long as the feed) and bottle rings share the top lane, like the
  // dial's outer ring; wet dots and dirty squares share the next; pumps get the last. Weight
  // has no dial mark and stays off. `mini` is the Week row's strip: two lanes, no axis.
  let {
    events,
    win,
    dayStart,
    tz,
    now,
    mini = false,
  }: {
    events: readonly BabyEvent[];
    win: DayWindow;
    dayStart: number;
    tz: string;
    now: number;
    mini?: boolean;
  } = $props();

  const W = $derived(mini ? 326 : 332);
  const H = $derived(mini ? 26 : 62);
  const k = $derived(mini ? 0.62 : 1);
  const x = (t: number) => 4 + ((t - win.start) / (win.end - win.start)) * (W - 8);
  const lane = $derived(mini ? { top: 7, mid: 19, low: 19 } : { top: 12, mid: 32, low: 52 });
  const midnight = $derived(midnightIn(win, tz));
  const change = $derived(clockChange(win, tz));
  const axis = $derived(ticks(win, dayStart, tz));

  type MarkKind = 'feed' | 'bottle' | 'wet' | 'dirty' | 'pump';
  const marks = $derived(
    events.flatMap((e): { kind: MarkKind; x: number; w: number }[] => {
      const t = Date.parse(e.occurredAt);
      if (e.type === 'breastfeed') {
        const end =
          e.data.durationSeconds === null
            ? Math.min(now, win.end)
            : t + e.data.durationSeconds * 1000;
        return [{ kind: 'feed', x: x(t), w: Math.max(3 * k, x(end) - x(t)) }];
      }
      if (e.type === 'bottle') return [{ kind: 'bottle', x: x(t), w: 0 }];
      if (e.type === 'pump') return mini ? [] : [{ kind: 'pump', x: x(t), w: 0 }];
      if (e.type === 'diaper') {
        // A mixed diaper is both, as on the dial.
        const out: { kind: MarkKind; x: number; w: number }[] = [];
        if (e.data.kind !== 'dirty') out.push({ kind: 'wet', x: x(t), w: 0 });
        if (e.data.kind !== 'wet') out.push({ kind: 'dirty', x: x(t), w: 0 });
        return out;
      }
      return [];
    }),
  );
</script>

<svg viewBox="0 0 {W} {H}" class:mini aria-hidden="true">
  {#if change?.back}
    <rect
      x={x(change.at)}
      y="0"
      width={x(change.at + 3_600_000) - x(change.at)}
      height={H}
      fill="var(--band)"
    />
  {/if}
  {#if !mini}
    {#each axis as t (t)}
      <line x1={x(t)} y1="0" x2={x(t)} y2={H} stroke="var(--line)" stroke-width="1" />
    {/each}
  {/if}
  {#if midnight !== null}
    <line
      x1={x(midnight)}
      y1="0"
      x2={x(midnight)}
      y2={H}
      stroke="var(--text-dim)"
      stroke-width="1"
      stroke-dasharray="2 3"
    />
  {/if}
  {#if change && !change.back && !mini}
    <line
      x1={x(change.at)}
      y1="0"
      x2={x(change.at)}
      y2={H}
      stroke="var(--ink)"
      stroke-width="1.5"
    />
  {/if}
  {#each marks as m, i (i)}
    {#if m.kind === 'feed'}
      <rect x={m.x} y={lane.top - 7 * k} width={m.w} height={14 * k} rx="1.5" fill="var(--feed)" />
    {:else if m.kind === 'bottle'}
      <circle
        cx={m.x}
        cy={lane.top}
        r={5 * k}
        fill="var(--panel)"
        stroke="var(--bottle)"
        stroke-width={2.5 * k}
      />
    {:else if m.kind === 'wet'}
      <circle cx={m.x} cy={lane.mid} r={5.5 * k} fill="var(--wet)" />
    {:else if m.kind === 'dirty'}
      <rect
        x={m.x - 5 * k}
        y={lane.mid - 5 * k}
        width={10 * k}
        height={10 * k}
        rx="1"
        fill="var(--dirty)"
      />
    {:else}
      <rect
        x={m.x - 4.5}
        y={lane.low - 4.5}
        width="9"
        height="9"
        fill="var(--pump)"
        transform="rotate(45 {m.x} {lane.low})"
      />
    {/if}
  {/each}
</svg>
{#if !mini}
  <div class="axis">
    {#each axis as t, i (t)}
      <span
        class:first={i === 0}
        class:last={i === axis.length - 1}
        style:left="{(x(t) / W) * 100}%">{hourText(t, tz)}</span
      >
    {/each}
  </div>
{/if}

<style>
  svg {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
  }
  .axis {
    position: relative;
    height: 21px;
    margin-top: 2px;
    font: 400 15px/1.35 var(--sans);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .axis span {
    position: absolute;
    transform: translateX(-50%);
    white-space: nowrap;
  }
  .axis .first {
    transform: none;
    left: 0 !important;
  }
  .axis .last {
    transform: none;
    left: auto !important;
    right: 0;
  }
</style>
