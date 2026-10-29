import 'fake-indexeddb/auto';
import { evaluate, type CheckId } from '@bht/insights';
import { newId, parseBaby, parseEvent, type BabyEvent } from '@bht/schema';
import { describe, expect, test } from 'vitest';
import { openDatabase } from '../data/db.ts';
import { EventStore } from '../data/store.ts';
import { fullyLogged, loggingStart } from '../ui/readings.ts';
import { runningFeed } from '../ui/logic.ts';
import { scenario, type ScenarioName } from './scenarios.ts';
import { KEYS, loadSeeded } from '../ui/prefs.ts';
import { loadScenario, writeScenario } from './seed.ts';

const NOW = Date.parse('2026-10-29T15:42:00.000Z');
/** Loads at different times of day shift the day-of-life windows against the clock. */
const NOWS = [1, 5, 9, 13, 17, 21].map((h) =>
  Date.parse(`2026-10-29T${String(h).padStart(2, '0')}:42:00.000Z`),
);
const DAY = 86_400_000;

async function load(name: ScenarioName, now = NOW) {
  const s = scenario(name, now);
  const db = await openDatabase(`seed-${newId()}`);
  const writes = await writeScenario(db, newId(), s);
  const events = s.baby ? await new EventStore(db, newId()).events(s.baby.id) : [];
  const versions = await db.getAll('versions');
  return { s, writes, events, versions };
}

/** Flags Readings would show at `now`, computed exactly as the Readings screen does. */
function flags(s: ReturnType<typeof scenario>, events: BabyEvent[], now: number): CheckId[] {
  const baby = s.baby!;
  const start = loggingStart(s.setupAt, events);
  return evaluate({
    baby,
    events,
    now: new Date(now).toISOString(),
    fullyLogged: fullyLogged(baby.birthAt, now, events, start),
    syncedThrough: new Date(now).toISOString(),
  })
    .filter((r) => r.status === 'flag')
    .map((r) => r.check)
    .sort();
}

/** Flags just after each day of life completes, from day 1 to the last full day, and now. */
function flagsByDay(s: ReturnType<typeof scenario>, events: BabyEvent[], now: number) {
  const birth = Date.parse(s.baby!.birthAt);
  const out: { day: number; flags: CheckId[] }[] = [];
  for (let d = 1; birth + d * DAY + 60_000 < now; d++) {
    out.push({ day: d, flags: flags(s, events, birth + d * DAY + 60_000) });
  }
  return out;
}

describe('dev seed scenarios (#58)', () => {
  test('empty is first-run: no baby, nothing written', async () => {
    const { s, writes } = await load('empty');
    expect(s.baby).toBeNull();
    expect(writes).toBe(0);
  });

  test.each(['healthy-month', 'incidents-month'] as const)(
    '%s: a valid month through the real write path',
    async (name) => {
      const { s, events, versions } = await load(name);
      expect(parseBaby(s.baby)).toEqual(s.baby);
      expect(s.baby!.name).toBe('Pip Testbaby');
      for (const v of versions) expect(parseEvent(v.event).ok).toBe(true);
      const birth = Date.parse(s.baby!.birthAt);
      expect((NOW - birth) / DAY).toBeGreaterThan(29.5);
      const types = new Set(events.map((e) => e.type));
      for (const t of ['breastfeed', 'bottle', 'diaper', 'pump', 'weight', 'weighted_feed'])
        expect(types).toContain(t);
      // Edits, an undone tap and backdated entries are all in the history.
      expect(versions.some((v) => v.event.version > 1 && v.event.type === 'bottle')).toBe(true);
      expect(versions.some((v) => v.event.deleted)).toBe(true);
      expect(
        events.some((e) => Date.parse(e.recordedAt) - Date.parse(e.occurredAt) > 3_600_000),
      ).toBe(true);
      expect(events.some((e) => e.type === 'bottle' && e.data.contents === 'formula')).toBe(true);
      // Something recent for the clock: a feed running right now, and entries today.
      expect(runningFeed(events)).toBeDefined();
      expect(events.filter((e) => Date.parse(e.occurredAt) > NOW - DAY).length).toBeGreaterThan(15);
      expect(events.every((e) => Date.parse(e.occurredAt) <= NOW)).toBe(true);
    },
  );

  test('the same scenario gives the same month', async () => {
    const a = await load('healthy-month');
    const b = await load('healthy-month');
    const shape = (es: BabyEvent[]) => es.map((e) => [e.type, e.occurredAt, e.data]);
    expect(shape(a.events)).toEqual(shape(b.events));
  });

  test.each(NOWS)('healthy-month raises no flag on any day (now %i)', async (now) => {
    const { s, events } = await load('healthy-month', now);
    const days = flagsByDay(s, events, now);
    expect(days.filter((d) => d.flags.length > 0)).toEqual([]);
    expect(flags(s, events, now)).toEqual([]);
  });

  test.each(NOWS)('incidents-month raises exactly the insights it lists (now %i)', async (now) => {
    const { s, events } = await load('incidents-month', now);
    const days = flagsByDay(s, events, now);
    for (const i of s.incidents) {
      expect(days.find((d) => d.day === i.day)?.flags, `${i.check} on day ${i.day}`).toContain(
        i.check,
      );
    }
    const raised = new Set(days.flatMap((d) => d.flags));
    expect([...raised].sort()).toEqual([...new Set(s.incidents.map((i) => i.check))].sort());
    expect(flags(s, events, now)).toEqual(
      s.incidents
        .filter((i) => i.showsNow)
        .map((i) => i.check)
        .sort(),
    );
  });
});

/** A localStorage stand-in with the Storage key enumeration loadScenario uses. */
function storage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe('loading a scenario (#58)', () => {
  const PREFS = JSON.stringify({ volume: 'oz', theme: 'night', dayStart: 300 });
  const AUTHOR = newId();

  test('marks the browser seeded, keeps prefs and author, and the mark survives a reload', async () => {
    const kv = storage({
      [KEYS.prefs]: PREFS,
      [KEYS.author]: AUTHOR,
      [KEYS.homeNoteDismissed]: '1',
      'other.app': 'kept',
    });
    expect(loadSeeded(kv)).toBe(false);
    const db = await openDatabase(`seed-${newId()}`);
    await loadScenario(db, kv, 'healthy-month', NOW);
    expect(loadSeeded(kv)).toBe(true);
    expect(kv.getItem(KEYS.prefs)).toBe(PREFS);
    expect(kv.getItem(KEYS.author)).toBe(AUTHOR);
    expect(kv.getItem(KEYS.homeNoteDismissed)).toBeNull();
    expect(kv.getItem('other.app')).toBe('kept');
    const baby = JSON.parse(kv.getItem(KEYS.baby)!) as { id: string };
    const events = await new EventStore(db, newId()).events(baby.id);
    // This phone's own author id logs one parent's entries.
    expect(events.some((e) => e.authorId === AUTHOR)).toBe(true);
    db.close();

    // A reload reads the same storage; seeding again, even to empty, keeps the mark.
    const again = await openDatabase(db.name);
    expect(loadSeeded(kv)).toBe(true);
    await loadScenario(again, kv, 'empty', NOW);
    expect(loadSeeded(kv)).toBe(true);
    expect(kv.getItem(KEYS.baby)).toBeNull();
    expect(await again.count('versions')).toBe(0);
    expect(kv.getItem(KEYS.prefs)).toBe(PREFS);
    expect(kv.getItem(KEYS.author)).toBe(AUTHOR);
  });
});
