import type { HouseholdDevice } from '@bht/schema';
import type { SyncStatus } from '../data/sync.ts';

/** What the screens know about sync: signed in or not, and the client's state. */
export interface SyncView {
  signedIn: boolean;
  status: SyncStatus;
  /** SyncClient.error: why the last run failed, while status is 'offline'. */
  error: string | null;
}

/** Home's quiet line under the legend. */
export function homeLine({ signedIn, status }: SyncView): string {
  if (!signedIn) return 'Saved on this phone · not synced';
  switch (status) {
    case 'idle':
      return 'Synced';
    case 'syncing':
      return 'Syncing';
    case 'offline':
      return 'Saved on this phone · sync paused';
    case 'signed_out':
      return 'Saved on this phone · sign in to sync';
  }
}

/** Settings' sync status: one sentence, plus the reason while sync is failing. */
export function settingsLine({ signedIn, status, error }: SyncView): string {
  if (!signedIn) return 'Logs are saved on this phone only.';
  switch (status) {
    case 'idle':
      return 'Synced with your household.';
    case 'syncing':
      return 'Syncing with your household.';
    case 'offline':
      return `Not synced: ${error ?? 'No connection to the server'}. Logs stay on this phone and retry on their own.`;
    case 'signed_out':
      return 'Signed out on this phone. Logs stay here until you sign in again.';
  }
}

/** The household's other phones Settings can remove: not this one, and not removed already. */
export function otherPhones(
  devices: readonly HouseholdDevice[] | null,
  self: string,
): HouseholdDevice[] {
  return (devices ?? []).filter((d) => d.deviceId !== self && d.removedAt === null);
}

/** A phone's line under its name in Settings. */
export function phoneLine(d: HouseholdDevice, time: (ms: number) => string): string {
  if (d.signedOutAt !== null) return `Signed out ${time(d.signedOutAt)}`;
  return d.watermark === null ? 'Not synced yet' : `Last synced ${time(d.watermark)}`;
}
