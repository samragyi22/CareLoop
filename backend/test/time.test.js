import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { zonedTimeToUtc, localTimeOnDay } from '../src/utils/time.js';
import { isSyntheticPhone } from '../src/utils/synthetic.js';

describe('timezone helpers', () => {
  it('converts IST wall-clock time to UTC', () => {
    const utc = zonedTimeToUtc({ year: 2026, month: 10, day: 21, hour: 9 }, 'Asia/Kolkata');
    assert.equal(utc.toISOString(), '2026-10-21T03:30:00.000Z');
  });

  it('handles daylight saving time on both sides of the change', () => {
    const summer = zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9 }, 'America/New_York');
    const winter = zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 9 }, 'America/New_York');
    assert.equal(summer.toISOString(), '2026-07-01T13:00:00.000Z');
    assert.equal(winter.toISOString(), '2026-12-01T14:00:00.000Z');
  });

  it('rolls over month ends when offsetting days', () => {
    const from = new Date('2026-10-31T06:00:00.000Z'); // 31 Oct, 11:30 IST
    const next = localTimeOnDay({ from, dayOffset: 1, hour: 9, timeZone: 'Asia/Kolkata' });
    assert.equal(next.toISOString(), '2026-11-01T03:30:00.000Z');
  });
});

describe('synthetic phone guard', () => {
  it('treats only fictional +1 555 numbers as synthetic', () => {
    assert.equal(isSyntheticPhone('+15550100101'), true);
    assert.equal(isSyntheticPhone('+15621234567'), false);
    assert.equal(isSyntheticPhone('+919876543210'), false);
    assert.equal(isSyntheticPhone(null), false);
  });
});
