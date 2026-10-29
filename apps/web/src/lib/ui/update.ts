import { afterNavigate, beforeNavigate, goto } from '$app/navigation';

/**
 * Brings a new build onto the screen without a string of reopens (#70). The service worker
 * serves the shell cache-first, so a launch always shows the build that worker cached; a new
 * worker installs in the background, takes control (skipWaiting, clients.claim) and the page
 * on screen is now the old build under the new worker. From then on:
 *
 * - the next screen change loads the new build instead of drawing the old one: a tap opens the
 *   next screen as a full page load. Screens start from their URL and the store, and a running
 *   feed or pump timer is already in IndexedDB, so nothing on screen is lost;
 * - leaving the app from Home reloads it, so the next launch opens on the new build.
 *
 * Neither happens while something is in progress: setup, the Undo toast a save leaves, a failed
 * save waiting for Retry, or a write that has started and not yet committed (#74), since a page
 * load aborts an IndexedDB transaction still queued. A form on screen is never reloaded, since
 * every path waits for the parent to leave it. The next screen change or exit retries; losing a
 * diaper is far worse than one more launch on the old build.
 *
 * A Home Screen app on iPhone resumes rather than relaunching, which checks for no new worker,
 * so resuming asks for one. Call from the root layout (navigation hooks need component init).
 */
export interface UpdateGuard {
  /** Nothing on screen is in progress: not setup, no Undo toast, no failed save. */
  idle: () => boolean;
  /** A write has started and not settled. */
  writing: () => boolean;
  /** Resolves once no write is in flight and what follows one (its toast or error) is set. */
  settled: () => Promise<void>;
}

export function watchForUpdates(guard: UpdateGuard): void {
  const sw = globalThis.navigator?.serviceWorker;
  if (!sw) return;
  // The first worker of a fresh install also claims the page; only a second one is a new build.
  let controlled = sw.controller !== null;
  let replaced = false;
  sw.addEventListener('controllerchange', () => {
    if (controlled) replaced = true;
    controlled = true;
  });

  const clear = () => replaced && guard.idle();

  /**
   * The only way this module loads a page. Skips this chance if anything is on screen in
   * progress. A write in flight is waited out (or, with `wait` false, skips this chance too),
   * then the screen is checked again, since that write may have raised a toast or an error. Resolves whether it loaded; the
   * update stays armed if not.
   */
  async function safeReload(
    kind: 'reload' | 'assign',
    { href = '', wait = true, still = (): boolean => true } = {},
  ) {
    if (!clear() || (!wait && guard.writing())) return false;
    await guard.settled();
    if (!clear() || !still()) return false;
    if (kind === 'assign') location.assign(href);
    else location.reload();
    return true;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void sw
        .getRegistration()
        .then((r) => r?.update())
        .catch(() => {}); // offline: the next resume tries again
    } else if (location.pathname === '/') {
      // The app may be suspended before a write settles, so leaving never waits for one: the
      // next launch or screen change picks up the new build instead.
      const leaving = () => document.visibilityState === 'hidden' && location.pathname === '/';
      void safeReload('reload', { wait: false, still: leaving });
    }
  });

  // A screen change that safeReload turned down goes ahead in this build.
  let inPlace = false;
  beforeNavigate((nav) => {
    if (inPlace || nav.willUnload || nav.type === 'popstate') return;
    // A tap during a write opens its screen in this build rather than waiting on storage.
    if (!clear() || guard.writing()) return;
    if (!nav.to || nav.to.url.origin !== location.origin) return;
    const url = nav.to.url;
    nav.cancel();
    void safeReload('assign', { href: url.href }).then(async (loaded) => {
      if (loaded) return;
      inPlace = true;
      try {
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- already resolved
        await goto(url);
      } finally {
        inPlace = false;
      }
    });
  });
  // Back and forward can't be redone as a page load before they happen; reload once drawn.
  afterNavigate(({ type }) => {
    if (type === 'popstate') void safeReload('reload');
  });
}
