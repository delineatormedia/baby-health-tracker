import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';
import SyncStatus from './SyncStatus.svelte';
import { homeLine } from './sync.ts';

// Component test (#46 release gate): Settings shows SyncClient.error while sync is offline.
const text = (props: Parameters<typeof render<typeof SyncStatus>>[1]) =>
  render(SyncStatus, props).body.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ');

describe('Settings sync status', () => {
  test('offline shows the client error, e.g. a proxy upload cap', () => {
    const html = text({
      props: {
        signedIn: true,
        status: 'offline',
        error: 'Server rejected upload size',
        rejected: 0,
      },
    });
    expect(html).toContain('Not synced: Server rejected upload size.');
    expect(html).toMatch(/class="note [^"]*\bflag\b/);
  });

  test('offline without a reason falls back to no connection', () => {
    const html = text({ props: { signedIn: true, status: 'offline', error: null, rejected: 0 } });
    expect(html).toContain('Not synced: No connection to the server.');
  });

  test('synced, signed out and never signed in each say where the logs are', () => {
    const at = (signedIn: boolean, status: 'idle' | 'signed_out') =>
      text({ props: { signedIn, status, error: null, rejected: 0 } });
    expect(at(true, 'idle')).toContain('Synced with your household.');
    expect(at(true, 'signed_out')).toContain('Signed out on this phone.');
    expect(at(false, 'idle')).toContain('Logs are saved on this phone only.');
    expect(at(true, 'idle')).not.toContain('Not synced');
  });

  test('refused entries are counted', () => {
    const one = text({ props: { signedIn: true, status: 'idle', error: null, rejected: 1 } });
    expect(one).toContain('1 entry the server refused.');
    const two = text({ props: { signedIn: true, status: 'idle', error: null, rejected: 2 } });
    expect(two).toContain('2 entries the server refused.');
    const none = text({ props: { signedIn: true, status: 'idle', error: null, rejected: 0 } });
    expect(none).not.toContain('refused');
  });
});

describe('Home sync line', () => {
  test('follows the client status once signed in', () => {
    const line = (signedIn: boolean, status: Parameters<typeof homeLine>[0]['status']) =>
      homeLine({ signedIn, status, error: null });
    expect(line(false, 'idle')).toBe('Saved on this phone · not synced');
    expect(line(true, 'idle')).toBe('Synced');
    expect(line(true, 'syncing')).toBe('Syncing');
    expect(line(true, 'offline')).toBe('Saved on this phone · sync paused');
    expect(line(true, 'signed_out')).toBe('Saved on this phone · sign in to sync');
  });
});
