import type { Baby, BabyEvent, HouseholdView } from '@bht/schema';

/**
 * Where this phone's baby stands after a sign-in (#5 step 3):
 * - `keep`: it is the household's (the phone registered it, or signed back in).
 * - `adopt`: the phone has none yet, so it takes the household's.
 * - `choose`: it has its own baby, not the household's; the parent moves its entries into
 *   the household baby or keeps them off the household first.
 * - `none`: neither side has a baby; Setup asks for one.
 */
export type Placement =
  { kind: 'keep' } | { kind: 'none' } | { kind: 'adopt' | 'choose'; baby: Baby };

export function placeBaby(local: Baby | null, household: HouseholdView): Placement {
  if (local && household.babies.some((b) => b.id === local.id)) return { kind: 'keep' };
  // v1 has one baby per household; the oldest is the one a joining phone takes.
  const baby = [...household.babies].sort(
    (a, b) => Date.parse(a.birthAt) - Date.parse(b.birthAt),
  )[0];
  if (!baby) return local ? { kind: 'keep' } : { kind: 'none' };
  return { kind: local ? 'choose' : 'adopt', baby };
}

/**
 * SyncClient's prepare hook: before a push carries entries for this phone's baby, makes sure
 * the server has that baby, or they come back "Unknown baby". `known` holds the household's
 * baby ids from sign-in; one POST adds a missing baby (the same id again is a safe retry).
 */
export function babyPreparer(
  addBaby: (baby: Baby) => Promise<unknown>,
  known: Set<string>,
  current: () => Baby | null,
): (batch: BabyEvent[]) => Promise<void> {
  return async (batch) => {
    const baby = current();
    if (!baby || known.has(baby.id) || !batch.some((e) => e.babyId === baby.id)) return;
    await addBaby(baby);
    known.add(baby.id);
  };
}

/**
 * An invite code as typed: case, spaces and dashes don't matter, and the letters Crockford
 * base32 leaves out read as the digits they look like. Null unless it makes ten characters.
 */
export function inviteCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? code : null;
}
