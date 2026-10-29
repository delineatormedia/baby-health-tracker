// #42: WebKit deletes a site's script-writable storage, IndexedDB included, after 7 days of
// Safari use without a visit. Home Screen web apps are exempt. Until sync is live every log
// exists only on this phone, so a Safari tab is told to add the app to the Home Screen.
// https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/

export interface DisplayEnv {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { standalone?: boolean };
}

/** Running from the Home Screen: display-mode standalone, or iOS Safari's navigator.standalone. */
export function isStandalone(env: DisplayEnv): boolean {
  if (env.navigator?.standalone === true) return true;
  try {
    return env.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    return false;
  }
}

export type Persistence = 'persisted' | 'not-persisted' | 'unknown';

export interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

/**
 * Reports whether the browser has promised to keep this site's storage. From the Home Screen
 * it asks for that promise when there isn't one yet; a Safari tab never asks.
 */
export async function ensurePersisted(
  storage: StorageManagerLike | undefined,
  standalone: boolean,
): Promise<Persistence> {
  if (typeof storage?.persisted !== 'function') return 'unknown';
  try {
    if (await storage.persisted()) return 'persisted';
    if (!standalone || typeof storage.persist !== 'function') return 'not-persisted';
    return (await storage.persist()) ? 'persisted' : 'not-persisted';
  } catch {
    return 'unknown';
  }
}

/** The Add to Home Screen note: after setup, in a browser tab, until dismissed. */
export function showHomeScreenNote(s: {
  hasBaby: boolean;
  standalone: boolean;
  dismissed: boolean;
}): boolean {
  return s.hasBaby && !s.standalone && !s.dismissed;
}
