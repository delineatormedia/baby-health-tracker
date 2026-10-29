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
 * Neither happens while `idle()` says something is in progress: setup, the Undo toast a save
 * leaves, or a failed save waiting for Retry. A form on screen is never reloaded, since both
 * paths wait for the parent to leave it. The next screen change or exit retries.
 *
 * A Home Screen app on iPhone resumes rather than relaunching, which checks for no new worker,
 * so resuming asks for one. Call from the root layout (navigation hooks need component init).
 */
export function watchForUpdates(idle: () => boolean): void {
  const sw = globalThis.navigator?.serviceWorker;
  if (!sw) return;
  // The first worker of a fresh install also claims the page; only a second one is a new build.
  let controlled = sw.controller !== null;
  let replaced = false;
  sw.addEventListener('controllerchange', () => {
    if (controlled) replaced = true;
    controlled = true;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void sw
        .getRegistration()
        .then((r) => r?.update())
        .catch(() => {}); // offline: the next resume tries again
    } else if (replaced && location.pathname === '/' && idle()) {
      location.reload();
    }
  });

  beforeNavigate((nav) => {
    if (!replaced || nav.willUnload || nav.type === 'popstate' || !idle()) return;
    if (!nav.to || nav.to.url.origin !== location.origin) return;
    nav.cancel();
    location.assign(nav.to.url.href);
  });
  // Back and forward can't be redone as a page load before they happen; reload once drawn.
  afterNavigate(({ type }) => {
    if (replaced && type === 'popstate' && idle()) location.reload();
  });
}
