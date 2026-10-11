/**
 * Small pure helpers for scheduler housekeeping: spotting missed schedule
 * runs and working out the run output retention window.
 */

/** A due run older than this counts as missed (e.g. after downtime). */
export const MISSED_GRACE_MS = 5 * 60_000;

export const DEFAULT_RUN_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;

/** True when a run was due long enough ago that it was missed, not just late. */
export const isMissedRun = (nextRunAt: Date | null | undefined, now: Date, graceMs = MISSED_GRACE_MS): boolean =>
  !!nextRunAt && now.getTime() - new Date(nextRunAt).getTime() > graceMs;

/**
 * Days to keep run output, from RUN_OUTPUT_RETENTION_DAYS. Unset means the
 * default (90); blank, 0 or anything not a positive number turns cleanup off.
 */
export const runRetentionDays = (raw: string | undefined = process.env.RUN_OUTPUT_RETENTION_DAYS): number => {
  if (raw === undefined) {
    return DEFAULT_RUN_RETENTION_DAYS;
  }

  const days = Number(raw.trim());
  return raw.trim() !== '' && Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
};

/** Cut-off date for deleting run output, or null when cleanup is off. */
export const retentionCutoff = (now: Date, days: number): Date | null =>
  days > 0 ? new Date(now.getTime() - days * DAY_MS) : null;

/** True when the daily cleanup should run (first tick, or a day since the last). */
export const cleanupDue = (lastRun: Date | null, now: Date): boolean =>
  !lastRun || now.getTime() - lastRun.getTime() >= DAY_MS;
