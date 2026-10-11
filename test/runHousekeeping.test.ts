import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RUN_RETENTION_DAYS,
  MISSED_GRACE_MS,
  cleanupDue,
  isMissedRun,
  retentionCutoff,
  runRetentionDays
} from '../src/utils/runHousekeeping';

const now = new Date('2026-10-11T20:00:00Z');

describe('missed schedule runs', () => {
  test('a run due within the grace window is just late, not missed', () => {
    assert.equal(isMissedRun(new Date(now.getTime() - 30_000), now), false);
    assert.equal(isMissedRun(new Date(now.getTime() - MISSED_GRACE_MS), now), false);
  });

  test('a run due well before now (downtime) is missed', () => {
    assert.equal(isMissedRun(new Date(now.getTime() - MISSED_GRACE_MS - 1), now), true);
    assert.equal(isMissedRun(new Date('2026-10-10T09:00:00Z'), now), true);
  });

  test('no next run is never missed', () => {
    assert.equal(isMissedRun(null, now), false);
  });
});

describe('run output retention', () => {
  test('defaults to 90 days when unset', () => {
    assert.equal(runRetentionDays(undefined), DEFAULT_RUN_RETENTION_DAYS);
    assert.equal(DEFAULT_RUN_RETENTION_DAYS, 90);
  });

  test('blank, 0 or junk turns cleanup off', () => {
    for (const raw of ['', ' ', '0', '-5', 'abc']) {
      assert.equal(runRetentionDays(raw), 0, raw);
    }
  });

  test('a positive number is used', () => {
    assert.equal(runRetentionDays('30'), 30);
    assert.equal(runRetentionDays(' 7.9 '), 7);
  });

  test('cut-off is N days back, or null when off', () => {
    assert.equal(retentionCutoff(now, 90)!.toISOString(), '2026-07-13T20:00:00.000Z');
    assert.equal(retentionCutoff(now, 0), null);
  });

  test('cleanup runs on the first tick, then once a day', () => {
    assert.equal(cleanupDue(null, now), true);
    assert.equal(cleanupDue(new Date(now.getTime() - 3600_000), now), false);
    assert.equal(cleanupDue(new Date(now.getTime() - 86_400_000), now), true);
  });
});
