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

/** What Readings knows about the other phones of the household. */
export interface SyncView {
  /** The adopted device list; null until a pull after sign-in has reached through. */
  devices: readonly HouseholdDevice[] | null;
  /** This phone's own device id, left out of the list. */
  self: string;
  /** The last pull's sample, or null after a reload or before the first pull. */
  sample: ClockSample | null;
  wall: number;
  mono: number;
}

/** The phones this phone waits on: every other device of the household. */
export function otherDevices(view: SyncView): HouseholdDevice[] {
  return (view.devices ?? []).filter((d) => d.deviceId !== view.self);
}

/**
 * How far every other phone's entries are known to be here, in this phone's clock (ms), or
 * null when nothing is: no device list yet, a phone with no watermark yet, or no sample that
 * still holds. The only phone of its household holds the whole log, so it is synced through
 * now (a phone that is not signed in does not ask). Removed phones still hold windows back
 * from their watermark until step 3b's second part makes removal a vouch.
 */
export function syncedThrough(view: SyncView): number | null {
  if (view.devices === null) return null;
  const others = otherDevices(view);
  if (others.length === 0) return view.wall;
  return others.reduce<number | null>((min, d) => {
    const w = coveredThrough(view, d);
    return min === null || w === null ? null : Math.min(min, w);
  }, view.wall);
}

/** W_local(D), or null when it is unknown. */
export function coveredThrough(view: SyncView, d: HouseholdDevice): number | null {
  if (d.watermark === null || !view.sample) return null;
  if (!sampleHolds(view.sample, view.wall, view.mono)) return null;
  return localWatermark(d.watermark, view.sample);
}

/** The other phones a window ending at `end` (ms) still waits on. */
export function waitingOn(view: SyncView, end: number): HouseholdDevice[] {
  return otherDevices(view).filter((d) => {
    const w = coveredThrough(view, d);
    return w === null || end > w;
  });
}
