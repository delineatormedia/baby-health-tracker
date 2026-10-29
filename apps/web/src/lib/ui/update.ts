import { afterNavigate, beforeNavigate } from '$app/navigation';

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
 * load aborts an IndexedDB transaction still queued. Nothing waits for that to end: a waiter
 * that fires later can land on a screen the parent has since opened and typed into. The chance
 * is skipped, the update stays armed, and the next screen change or exit tries again from
 * scratch. Nor is a screen that stays mounted reloaded once something is entered on it. Losing a diaper is far worse
 * than one more launch on the old build.
 *
 * A Home Screen app on iPhone resumes rather than relaunching, which checks for no new worker,
 * so resuming asks for one. Call from the root layout (navigation hooks need component init).
 */
export interface UpdateGuard {
  /** Nothing on screen is in progress: not setup, no Undo toast, no failed save. */
  idle: () => boolean;
  /** A write has started and not settled. */
  writing: () => boolean;
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

  // The parent has typed, tapped or picked on the screen drawn now (most entry is buttons, which
  // fire no input event). Cleared when a different screen draws; a screen that stays mounted
  // across a query change keeps what was entered.
  let entered = false;
  for (const type of ['input', 'pointerdown', 'keydown'])
    document.addEventListener(type, () => (entered = true), true);

  /** Whether a page load now loses nothing. Checked at the moment of loading, never earlier. */
  const clear = () => replaced && guard.idle() && !guard.writing();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void sw
        .getRegistration()
        .then((r) => r?.update())
        .catch(() => {}); // offline: the next resume tries again
    } else if (location.pathname === '/' && clear()) {
      location.reload();
    }
  });

  beforeNavigate((nav) => {
    if (nav.willUnload || nav.type === 'popstate') return;
    if (!nav.to || nav.to.url.origin !== location.origin) return;
    // What is typed belongs to the screen being left, unless the same screen stays mounted.
    const leaving = nav.from?.route.id !== nav.to.route.id;
    if (!clear() || (entered && !leaving)) return;
    nav.cancel();
    location.assign(nav.to.url.href);
  });
  // Back and forward can't be redone as a page load before they happen; reload once drawn, if
  // the screen that just drew is still clear.
  afterNavigate(({ type, from, to }) => {
    if (from?.route.id !== to?.route.id) entered = false;
    if (type === 'popstate' && clear() && !entered) location.reload();
  });
}
