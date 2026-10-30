import { describe, expect, test } from 'vitest';
import { otherPhones, phoneLine } from './sync.ts';

const phone = (over: Partial<Parameters<typeof phoneLine>[0]> = {}) => ({
  deviceId: 'd1',
  memberName: 'Sam',
  watermark: null,
  lastSeenAt: 0,
  removedAt: null,
  signedOutAt: null,
  ...over,
});

describe('Settings phones (#5 step 3b)', () => {
  test('lists the other phones, not this one or a removed one', () => {
    const others = [phone({ deviceId: 'b' }), phone({ deviceId: 'c', signedOutAt: 5 })];
    const all = [phone({ deviceId: 'self' }), ...others, phone({ deviceId: 'r', removedAt: 9 })];
    expect(otherPhones(all, 'self')).toEqual(others);
    expect(otherPhones(null, 'self')).toEqual([]);
  });

  test('says when each phone last synced, or that it signed out', () => {
    const t = (ms: number) => `t${ms}`;
    expect(phoneLine(phone(), t)).toBe('Not synced yet');
    expect(phoneLine(phone({ watermark: 7 }), t)).toBe('Last synced t7');
    expect(phoneLine(phone({ watermark: 7, signedOutAt: 8 }), t)).toBe('Signed out t8');
  });
});
