import type { Stool } from '@bht/schema';
import type { Change, EventStore } from '../data/store.ts';
import type { Diaper } from './logic.ts';

/**
 * Saves the Dirty/Mixed details screen and returns what its Undo should take back, or null when
 * there is nothing to undo. `fresh` is the step straight after the color tap: the diaper was
 * just logged, so Undo removes it whole. Reopened later (the toast's Details), Undo reverts only
 * this edit to the previous version, exact old time included.
 */
export async function saveDetails(
  store: EventStore,
  event: Diaper,
  next: { stool: Stool; occurredAt: string },
  fresh: boolean,
): Promise<Change | null> {
  if (event.data.kind === 'wet') return null;
  const prev = event.data.stool ?? { color: null, consistency: null, size: null, flags: [] };
  const moved = next.occurredAt !== event.occurredAt;
  const changed =
    next.stool.consistency !== prev.consistency ||
    next.stool.size !== prev.size ||
    next.stool.flags.join() !== prev.flags.join();
  // Details and the time land as one new version: one sync, one undo.
  const edit =
    moved || changed
      ? await store.edit(event.id, {
          data: { kind: event.data.kind, stool: next.stool },
          ...(moved ? { occurredAt: next.occurredAt } : {}),
        })
      : null;
  if (fresh) return { event: edit?.event ?? event, undo: () => store.remove(event.id) };
  return edit;
}

/**
 * The inline control beside "Logged". Fresh, it is Undo: the diaper was just logged, so it goes.
 * Reopened, it is Cancel: unsaved inputs are dropped and the saved diaper is left exactly as is.
 */
export async function leaveDetails(
  store: EventStore,
  event: Diaper,
  fresh: boolean,
): Promise<void> {
  if (fresh) await store.remove(event.id);
}
