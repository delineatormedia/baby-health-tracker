import type { HouseholdDevice } from '@bht/schema';

// Converting other phones' watermarks to this phone's clock (#5 step 3b, #17, #44). Readings
// only assesses a window once every other phone has uploaded what it recorded in it.

/**
 * A pull's clock sample: this phone's wall and monotonic clocks just before the first page was
 * sent, and the serverNow that page carried. The server read serverNow after the request left,
 * so with θ the true offset (server clock − local clock), θ ≤ serverNow − tSend. In memory
 * only: performance.now() restarts with each page load.
 */
export interface ClockSample {
  tSend: number;
  pSend: number;
  serverNow: number;
  /** This phone's wall clock when the first page arrived; bounds θ from below. */
  tRecv: number;
}

/**
 * How far the wall clock may move against the monotonic clock before a sample is discarded,
 * and how much earlier every converted watermark is placed (#44). Subtracting the same amount
 * the check allows covers any jump the check lets through, in either direction.
 */
export const DRIFT_BUDGET_MS = 2_000;

/**
 * Whether the sample still holds: the wall clock moved within DRIFT_BUDGET_MS of the
 * monotonic clock since it was taken. A larger gap means the time was changed, or the phone
 * slept with the monotonic clock paused, and the sample says nothing about the clock now.
 */
export function sampleHolds(s: ClockSample, wall: number, mono: number): boolean {
  return Math.abs(wall - s.tSend - (mono - s.pSend)) <= DRIFT_BUDGET_MS;
}

/**
 * W_local(D) = W(D) − θ_max − DRIFT_BUDGET_MS: on this phone's clock, at or before the local
 * instant W(D) names. Network delay only makes θ_max larger, so the line only moves earlier.
 */
export function localWatermark(watermark: number, s: ClockSample): number {
  return watermark - (s.serverNow - s.tSend) - DRIFT_BUDGET_MS;
}

/**
 * A server time on this phone's clock, placed at or after the local instant it names: for
 * removal, which is a vouch from that time on, so the line may only move later. The server read
 * serverNow before the answer arrived at tRecv, so θ ≥ serverNow − tRecv.
 */
export function localLater(t: number, s: ClockSample): number {
  return t - (s.serverNow - s.tRecv) + DRIFT_BUDGET_MS;
}

/** A "Count without" mark for one phone, on this phone's clock (ms). */
export interface Vouch {
  deviceId: string;
  start: number | null;
  end: number;
}

/** What Readings knows about the other phones of the household. */
export interface SyncView {
  /** The household's phones: adopted from a pull, or kept from an earlier session. */
  devices: readonly HouseholdDevice[] | null;
  /**
   * Whether a pull in this session has reached through and supplied `devices`. Until then the
   * list is the one kept from an earlier session, for labels only: a phone may have joined
   * since, so nothing is assessed.
   */
  current: boolean;
  /** This phone's own device id, left out of the list. */
  self: string;
  /** The last pull's sample, or null after a reload or before the first pull. */
  sample: ClockSample | null;
  wall: number;
  mono: number;
  /** Live "Count without" marks. */
  vouches?: readonly Vouch[];
}

/** Closed spans in ms, sorted and merged; ±Infinity where unbounded. */
export type Spans = [number, number][];

const ALL: Spans = [[-Infinity, Infinity]];

/** The phones this phone waits on: every other device of the household. */
export function otherDevices(view: SyncView): HouseholdDevice[] {
  return (view.devices ?? []).filter((d) => d.deviceId !== view.self);
}

/**
 * When phone D's entries are known to be here, on this phone's clock (#5 step 3b):
 * - up to W_local(D), its converted watermark;
 * - from its removal on, removal being the household's vouch (converted the other way, so a
 *   window before the removal never passes);
 * - inside every "Count without D" mark;
 * - always, once it signed out after a barrier covering every write it made.
 * Without a sample that still holds, only the marks count: they are on this phone's clock.
 */
export function deviceSpans(view: SyncView, d: HouseholdDevice): Spans {
  if (d.signedOutAt !== null) return ALL;
  const spans: Spans = [];
  const w = coveredThrough(view, d);
  if (w !== null) spans.push([-Infinity, w]);
  const s = view.sample;
  if (d.removedAt !== null && s && sampleHolds(s, view.wall, view.mono)) {
    spans.push([localLater(d.removedAt, s), Infinity]);
  }
  for (const v of view.vouches ?? []) {
    if (v.deviceId === d.deviceId) spans.push([v.start ?? -Infinity, v.end]);
  }
  return merge(spans);
}

/**
 * The spans every other phone has uploaded or a parent vouched for, on this phone's clock: the
 * predicate Readings passes to evaluate(). A window is assessed only inside one span. Nothing
 * is synced until this session's first pull has reached through: a list kept from an earlier
 * session is for labels only. The only phone of its household holds the whole log
 * (a phone that is not signed in does not ask).
 */
export function syncedSpans(view: SyncView): Spans {
  if (!view.current || view.devices === null) return [];
  return otherDevices(view).reduce((acc, d) => intersect(acc, deviceSpans(view, d)), ALL);
}

/**
 * How far back from now everything is synced: the end of the span that runs from the distant
 * past, or null when there is none. Infinity when no other phone is waited on.
 */
export function syncedThrough(view: SyncView): number | null {
  const first = syncedSpans(view)[0];
  return first && first[0] === -Infinity ? first[1] : null;
}

/** W_local(D), or null when it is unknown. */
export function coveredThrough(view: SyncView, d: HouseholdDevice): number | null {
  if (d.watermark === null || !view.sample) return null;
  if (!sampleHolds(view.sample, view.wall, view.mono)) return null;
  return localWatermark(d.watermark, view.sample);
}

/** The other phones the window [start, end] (ms) still waits on. */
export function waitingOn(view: SyncView, end: number, start = -Infinity): HouseholdDevice[] {
  return otherDevices(view).filter(
    (d) => !deviceSpans(view, d).some(([s, e]) => s <= start && end <= e),
  );
}

function merge(spans: Spans): Spans {
  const out: Spans = [];
  for (const [s, e] of [...spans].filter(([s, e]) => s <= e).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intersect(a: Spans, b: Spans): Spans {
  const out: Spans = [];
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      const s = Math.max(as, bs);
      const e = Math.min(ae, be);
      if (s <= e) out.push([s, e]);
    }
  }
  return merge(out);
}

/**
 * The other phones a not_synced check waits on. A window outside the synced spans waits on the
 * phones that do not cover it. A window inside one (no_urine's, clamped to the span's end: "no
 * wet diaper in the 8 h before the pull") is asking about now, so it waits on every phone that
 * does not cover it through now, starting with the one whose watermark clamped it.
 */
export function waitingOnWindow(view: SyncView, start: number, end: number): HouseholdDevice[] {
  const inside = syncedSpans(view).some(([s, e]) => s <= start && end <= e);
  return waitingOn(view, inside ? Math.max(end, view.wall) : end, start);
}
