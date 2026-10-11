import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCronTime, nextCronTimes, parseCron, isValidTimezone } from '../src/utils/cron';

const iso = (dates: Date[]) => dates.map(date => date.toISOString());

describe('cron', () => {
  test('9am on Mondays follows London daylight saving', () => {
    assert.deepEqual(iso(nextCronTimes('0 9 * * mon', 'Europe/London', new Date('2026-10-12T12:00:00Z'), 3)), [
      '2026-10-19T08:00:00.000Z', // BST
      '2026-10-26T09:00:00.000Z', // GMT after the clocks go back
      '2026-11-02T09:00:00.000Z'
    ]);
  });

  test('steps, ranges, lists and names', () => {
    assert.deepEqual(iso(nextCronTimes('*/20 8-9 * * 1-5', 'UTC', new Date('2026-10-02T09:30:00Z'), 3)), [
      '2026-10-02T09:40:00.000Z',
      '2026-10-05T08:00:00.000Z', // skips the weekend
      '2026-10-05T08:20:00.000Z'
    ]);
    assert.deepEqual(iso(nextCronTimes('0 0 1 jan,jul *', 'UTC', new Date('2026-03-01T00:00:00Z'), 2)), [
      '2026-07-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z'
    ]);
  });

  test('day of month and weekday match either one, like standard cron', () => {
    assert.deepEqual(iso(nextCronTimes('0 12 1 * fri', 'UTC', new Date('2026-09-30T00:00:00Z'), 3)), [
      '2026-10-01T12:00:00.000Z',
      '2026-10-02T12:00:00.000Z',
      '2026-10-09T12:00:00.000Z'
    ]);
  });

  test('presets and Sunday as 7', () => {
    assert.equal(nextCronTime('@daily', 'UTC', new Date('2026-09-30T10:00:00Z'))!.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(nextCronTime('0 0 * * 7', 'UTC', new Date('2026-09-30T10:00:00Z'))!.toISOString(), '2026-10-04T00:00:00.000Z');
  });

  test('always strictly after the given time', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    assert.equal(nextCronTime('0 0 * * *', 'UTC', at)!.toISOString(), '2026-10-02T00:00:00.000Z');
  });

  test('impossible dates give null; bad input throws', () => {
    assert.equal(nextCronTime('0 0 31 2 *', 'UTC', new Date('2026-01-01T00:00:00Z')), null);
    assert.throws(() => parseCron('61 * * * *'), /out of range/);
    assert.throws(() => parseCron('* * *'), /five fields/);
    assert.throws(() => parseCron('5-1 * * * *'), /backwards/);
    assert.equal(isValidTimezone('Europe/London'), true);
    assert.equal(isValidTimezone('Mars/Olympus'), false);
  });
});
