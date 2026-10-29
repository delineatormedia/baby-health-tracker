import { newId, type HouseholdDevice } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import {
  DRIFT_BUDGET_MS,
  localWatermark,
  sampleHolds,
  syncedThrough,
  waitingOn,
  type ClockSample,
  type SyncView,
} from './watermarks.ts';

// Converting watermarks to this phone's clock (#5 step 3b, #17) and the drift budget (#44).

const S = 1_000;
const MIN = 60 * S;
const H = 60 * MIN;
const NOON = Date.parse('2026-10-29T12:00:00.000Z');
const self = newId();

function device(memberName: string, watermark: number | null): HouseholdDevice {
  return { deviceId: newId(), memberName, watermark, lastSeenAt: NOON, removedAt: null, signedOutAt: null };
}

/** A view at the moment the sample was taken, plus `elapsed` on both clocks. */
function view(
  devices: HouseholdDevice[] | null,
  sample: ClockSample | null,
  elapsed = 0,
  jump = 0,
  current = devices !== null,
): SyncView {
  const tSend = sample?.tSend ?? NOON;
  const pSend = sample?.pSend ?? 0;
  return { devices, current, self, sample, wall: tSend + elapsed + jump, mono: pSend + elapsed };
}

/** Clocks agree: sent at noon, the server read serverNow `delay` later. */
const agreed = (delay = 0): ClockSample => ({
  tSend: NOON,
  pSend: 5_000,
  serverNow: NOON + delay,
  tRecv: NOON + delay,
});

describe('localWatermark', () => {
  test('delayed response: a window ending between W and arrival is not assessed', () => {
    // W(D) and serverNow are 12:00; the request left at 12:00 and the answer arrived at 12:02.
    // D still holds a write from 12:00:30. A window ending 12:01 must wait.
    const sam = device('Sam', NOON);
    const v = view([sam], agreed(0), 2 * MIN);
    const end = NOON + MIN;
    expect(waitingOn(v, end)).toEqual([sam]);
    expect(syncedThrough(v)).toBeLessThan(NOON + 30 * S);

    // Control: an estimate from the arrival time counts the 2 minutes as clock offset and
    // moves the line to 12:02, passing the window.
    const arrival = NOON + 2 * MIN;
    const arrivalEstimate = sam.watermark! - (NOON - arrival);
    expect(end <= arrivalEstimate).toBe(true);
  });

  test('delayed pagination: page 1’s sample still decides after a slow page 2', () => {
    // Page 1 left at 12:00 with serverNow 12:00; page 2 arrived at 12:05. The sample is page 1's.
    const sam = device('Sam', NOON);
    const v = view([sam], agreed(0), 5 * MIN);
    expect(waitingOn(v, NOON + MIN)).toEqual([sam]);
  });

  test('property: W_local never passes the local instant W names, for any offset and delay', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 5_000; i++) {
      const theta = Math.round((rand() - 0.5) * 2 * 6 * H); // server − local, ±6 h
      const tSend = NOON + Math.round(rand() * H);
      const up = Math.round(rand() * 10 * MIN); // request on the wire before serverNow is read
      const serverNow = tSend + up + theta;
      const w = serverNow - Math.round(rand() * 48 * H); // a watermark at or before serverNow
      // A jump the check allows, either way, moves the local instant W names by `jump`.
      const jump = Math.round((rand() - 0.5) * 2 * DRIFT_BUDGET_MS);
      const sample = { tSend, pSend: 0, serverNow, tRecv: tSend + up };
      expect(sampleHolds(sample, tSend + MIN + jump, MIN)).toBe(true);
      expect(localWatermark(w, sample)).toBeLessThanOrEqual(w - theta + jump);
    }
  });

  test('clock skew: hours ahead or behind, a window just after W is never assessed', () => {
    for (const theta of [-5 * H, -1, 0, 1, 3 * H]) {
      for (const delay of [0, 400, 90 * S]) {
        // This phone's clock reads tSend; the server's reads tSend + theta.
        const sample = { tSend: NOON, pSend: 0, serverNow: NOON + delay + theta, tRecv: NOON + delay };
        const w = NOON + theta; // the server time at the instant the request left
        const sam = device('Sam', w);
        const localInstant = w - theta;
        expect(waitingOn(view([sam], sample, delay), localInstant + 1)).toEqual([sam]);
      }
    }
  });
});

describe('clock jumps (#44)', () => {
  const sam = device('Sam', NOON);
  const sample = agreed(0);

  test('an hour’s jump discards the sample: windows wait until the next pull', () => {
    for (const jump of [H, -H]) {
      const v = view([sam], sample, S, jump);
      expect(syncedThrough(v)).toBeNull();
      expect(waitingOn(v, NOON - H)).toEqual([sam]);
    }
  });

  test('small jumps either way keep the sample, and the budget covers them', () => {
    for (const jump of [S, -S, DRIFT_BUDGET_MS, -DRIFT_BUDGET_MS]) {
      const v = view([sam], sample, MIN, jump);
      expect(syncedThrough(v)).toBe(NOON - DRIFT_BUDGET_MS);
      // After the jump, W names local time NOON + jump. The line stays at or before it.
      expect(syncedThrough(v)!).toBeLessThanOrEqual(NOON + jump);
    }
  });

  test('just past the budget, either way, discards it', () => {
    for (const jump of [DRIFT_BUDGET_MS + 1, -DRIFT_BUDGET_MS - 1]) {
      expect(syncedThrough(view([sam], sample, MIN, jump))).toBeNull();
    }
  });
});

describe('syncedThrough', () => {
  test('the only phone of its household is synced through now', () => {
    const me = { ...device('Maya', null), deviceId: self };
    expect(syncedThrough(view([me], null, 0))).toBe(Infinity);
    expect(syncedThrough(view([], null, 0))).toBe(Infinity);
  });

  test('a list kept from an earlier session assesses nothing, even with only this phone', () => {
    // A second phone may have joined since it was stored: windows wait for this session's pull.
    const me = { ...device('Maya', null), deviceId: self };
    expect(syncedThrough(view([me], null, 0, 0, false))).toBeNull();
    expect(syncedThrough(view([me, device('Sam', NOON)], agreed(), MIN, 0, false))).toBeNull();
  });

  test('no device list yet: nothing is synced', () => {
    expect(syncedThrough(view(null, agreed()))).toBeNull();
    expect(waitingOn(view(null, agreed()), NOON - H)).toEqual([]);
  });

  test('a new phone with no watermark holds every window back', () => {
    const fresh = device('Sam', null);
    const v = view([fresh], agreed());
    expect(syncedThrough(v)).toBeNull();
    expect(waitingOn(v, NOON - 30 * 24 * H)).toEqual([fresh]);
  });

  test('two phones: it stops at the earlier watermark, and names only the phones behind', () => {
    const sam = device('Sam', NOON - H);
    const ana = device('Ana', NOON - 10 * MIN);
    const v = view([sam, ana], agreed());
    expect(syncedThrough(v)).toBe(NOON - H - DRIFT_BUDGET_MS);
    expect(waitingOn(v, NOON - 30 * MIN)).toEqual([sam]);
    expect(waitingOn(v, NOON)).toEqual([sam, ana]);
    expect(waitingOn(v, NOON - 2 * H)).toEqual([]);
  });

  test('a silent phone holds windows back however long it is silent', () => {
    const sam = device('Sam', NOON - 48 * H);
    const v = view([sam], { tSend: NOON, pSend: 0, serverNow: NOON, tRecv: NOON }, 0);
    expect(waitingOn(v, NOON)).toEqual([sam]);
    expect(waitingOn(v, NOON - 24 * H)).toEqual([sam]);
  });

  test('after a reload there is no sample: windows wait, the list stays for its text', () => {
    const sam = device('Sam', NOON - MIN);
    const v = view([sam], null);
    expect(syncedThrough(v)).toBeNull();
    expect(waitingOn(v, NOON - H)).toEqual([sam]);
  });

  test('property: min over phones matches the per-window rule both ways', () => {
    let seed = 11;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2_000; i++) {
      const devices = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, k) => {
        const d = device(`P${k}`, rand() < 0.15 ? null : NOON - Math.round(rand() * 30 * H));
        // Removed phones still hold windows back until removal becomes a vouch (3b-2).
        return rand() < 0.2 ? { ...d, removedAt: NOON - Math.round(rand() * 30 * H) } : d;
      });
      if (rand() < 0.3) devices.push({ ...device('Me', null), deviceId: self });
      const offset = Math.round((rand() - 0.5) * H);
      const sample = { tSend: NOON, pSend: 0, serverNow: NOON + offset, tRecv: NOON };
      const v = view(devices, rand() < 0.1 ? null : sample, Math.round(rand() * MIN));
      const through = syncedThrough(v);
      for (let j = 0; j < 20; j++) {
        const end = NOON - Math.round(rand() * 36 * H);
        const assessed = through !== null && end <= through;
        // The plan's rule: every other phone covers the window's end.
        expect(assessed).toBe(waitingOn(v, end).length === 0);
      }
    }
  });
});
