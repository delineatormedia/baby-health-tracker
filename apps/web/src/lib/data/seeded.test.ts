import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { httpAccount, signInFailure } from './account.ts';
import { httpTransport } from './protocol.ts';
import { KEYS } from '../ui/prefs.ts';
import { SEEDED_REFUSAL, SeededRefusal, isLocalHost } from './seeded.ts';
import { failureReason } from './sync.ts';

// A seeded dev browser (#58) must not reach a real server (#55).

let kv: Map<string, string>;
let fetched: string[];

function at(href: string) {
  vi.stubGlobal('location', new URL(href));
}

beforeEach(() => {
  kv = new Map();
  fetched = [];
  vi.stubGlobal('localStorage', { getItem: (k: string) => kv.get(k) ?? null });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ versions: [], next: 0, through: 0, more: false }));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('isLocalHost', () => {
  test.each(['localhost', 'LOCALHOST', 'bht.localhost', '127.0.0.1', '127.1.2.3', '[::1]'])(
    '%s is this computer',
    (host) => expect(isLocalHost(host)).toBe(true),
  );
  test.each(['bht.example', '192.168.1.20', '10.0.0.2', 'localhost.example', '128.0.0.1', ''])(
    '%s is a real server',
    (host) => expect(isLocalHost(host)).toBe(false),
  );
});

describe('a seeded browser', () => {
  test('sends no sync request to a real server', async () => {
    kv.set(KEYS.seeded, '1');
    at('https://bht.example/');
    const http = httpTransport();
    await expect(http.push([])).rejects.toBeInstanceOf(SeededRefusal);
    await expect(http.pull(0, 10)).rejects.toBeInstanceOf(SeededRefusal);
    expect(fetched).toEqual([]);
  });

  test('sends no account request to a real server, the home network included', async () => {
    kv.set(KEYS.seeded, '1');
    at('http://192.168.1.20:8787/');
    const http = httpAccount();
    await expect(http.get('/api/household')).rejects.toBeInstanceOf(SeededRefusal);
    await expect(http.post('/api/auth/login/options', {})).rejects.toBeInstanceOf(SeededRefusal);
    expect(fetched).toEqual([]);
  });

  test('judges an absolute base by its own host, not the page', async () => {
    kv.set(KEYS.seeded, '1');
    at('http://localhost:5173/');
    await expect(httpTransport('https://bht.example').pull(0, 10)).rejects.toBeInstanceOf(
      SeededRefusal,
    );
    expect(fetched).toEqual([]);
  });

  test('still syncs with a dev server on this computer', async () => {
    kv.set(KEYS.seeded, '1');
    at('http://localhost:5173/');
    await httpTransport().pull(0, 10);
    at('http://127.0.0.1:8787/');
    await httpTransport().pull(0, 10);
    expect(fetched).toHaveLength(2);
  });
});

test('an unseeded browser syncs with a real server', async () => {
  at('https://bht.example/');
  await httpTransport().pull(0, 10);
  expect(fetched).toHaveLength(1);
});

test('the refusal reads clearly in Settings and on the sign-in screen', () => {
  expect(failureReason(new SeededRefusal())).toBe(SEEDED_REFUSAL);
  expect(signInFailure(new SeededRefusal())).toBe(
    `${SEEDED_REFUSAL}. Clear local data to sign in.`,
  );
});
