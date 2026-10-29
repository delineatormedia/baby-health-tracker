/**
 * Test data never leaves for a real server. The dev seed (#58) sets this key, and only
 * clearing local data removes it. While it is set, every request to the server is refused
 * unless the server is on this computer, so a seeded dev browser that signs in to the family
 * server cannot upload a test baby.
 */
export const SEEDED_KEY = 'bht.seeded';

/** Why sync and sign-in stop, as Settings and the sign-in screen show it. */
export const SEEDED_REFUSAL = 'Test data on this phone only syncs with a localhost server';

export class SeededRefusal extends Error {
  constructor() {
    super(SEEDED_REFUSAL);
    this.name = 'SeededRefusal';
  }
}

/** Loopback only: a family server on the home network is a real server. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

function seeded(): boolean {
  try {
    return globalThis.localStorage?.getItem(SEEDED_KEY) != null;
  } catch {
    // Storage that throws stops the app at init; there is no seeded data to protect.
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).hostname;
  } catch {
    return '';
  }
}

/** Throws SeededRefusal before a request to `url` would carry test data off this computer. */
export function refuseSeeded(url: string): void {
  if (seeded() && !isLocalHost(hostOf(url))) throw new SeededRefusal();
}
