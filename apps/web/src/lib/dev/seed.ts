import type { Database } from '../data/db.ts';
import { EventStore } from '../data/store.ts';
import { authorId, KEYS, markSeeded, saveBaby } from '../ui/prefs.ts';
import {
  isScenario,
  scenario,
  type Scenario,
  type ScenarioName,
  type Writer,
} from './scenarios.ts';

/** The other parent's phone in the fake household. */
const OTHER_PARENT = '01JTESTPARENT2000000000000';

/**
 * Writes a scenario through EventStore, the same path every screen uses, with the clock set
 * to when each write would have happened. Returns the number of writes.
 */
export async function writeScenario(db: Database, author: string, s: Scenario): Promise<number> {
  let clock = 0;
  const now = () => new Date(clock);
  const stores = [new EventStore(db, author, now), new EventStore(db, OTHER_PARENT, now)];
  let parent: 0 | 1 = 0;
  let writes = 0;
  const w: Writer = {
    at(ms, p) {
      clock = ms;
      if (p !== undefined) parent = p;
    },
    async log(type, data, occurredAt) {
      writes++;
      const at = occurredAt === undefined ? undefined : new Date(occurredAt).toISOString();
      return (await stores[parent]!.log(s.baby!.id, type, data, { occurredAt: at })).event;
    },
    async edit(id, fields) {
      writes++;
      return (await stores[parent]!.edit(id, fields)).event;
    },
    async remove(id) {
      writes++;
      await stores[parent]!.remove(id);
    },
  };
  await s.write(w);
  return writes;
}

/**
 * Replaces this browser's local data with a scenario: every stored version, the sync cursor,
 * the baby, setup time and anything else under `bht.`, except display prefs, this phone's
 * author id and the seeded marker. The marker is set first, so even a seed that fails part
 * way leaves the browser marked. Nothing is pushed: the seeded entries wait as pending like
 * any offline log, and sync refuses non-local servers while the marker is set (#55).
 */
export async function loadScenario(
  db: Database,
  kv: Storage,
  name: ScenarioName,
  now: number,
): Promise<number> {
  markSeeded(kv);
  const tx = db.transaction(['versions', 'meta'], 'readwrite');
  await Promise.all([tx.objectStore('versions').clear(), tx.objectStore('meta').clear(), tx.done]);
  const keep = new Set<string>([KEYS.prefs, KEYS.author, KEYS.seeded]);
  const keys = Array.from({ length: kv.length }, (_, i) => kv.key(i)).filter(
    (k): k is string => k !== null && k.startsWith('bht.') && !keep.has(k),
  );
  for (const key of keys) kv.removeItem(key);
  const s = scenario(name, now);
  if (s.baby) {
    saveBaby(kv, s.baby);
    kv.setItem(KEYS.setupAt, String(s.setupAt));
  }
  return writeScenario(db, authorId(kv), s);
}

/**
 * `?seed=<scenario>` in a dev build: asks first, loads the scenario, then drops the parameter
 * so a reload doesn't seed again. Production builds never include this module: the only
 * import sits behind `import.meta.env.DEV`, and the build check fails if it leaks.
 */
export async function seedFromUrl(
  kv: Storage,
  open: () => Promise<Database>,
  ask: (q: string) => boolean = (q) => globalThis.confirm(q),
): Promise<void> {
  const url = new URL(globalThis.location.href);
  const name = url.searchParams.get('seed');
  if (name === null) return;
  url.searchParams.delete('seed');
  globalThis.history.replaceState(globalThis.history.state, '', url);
  if (!isScenario(name)) {
    console.warn(`Unknown seed scenario "${name}"`);
    return;
  }
  if (!ask(`Replace this browser's local baby data with the "${name}" test scenario?`)) return;
  const db = await open();
  try {
    const t = performance.now();
    const writes = await loadScenario(db, kv, name, Date.now());
    console.info(`Seeded ${name}: ${writes} writes in ${Math.round(performance.now() - t)} ms`);
  } finally {
    db.close();
  }
}
