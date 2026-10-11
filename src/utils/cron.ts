/**
 * Five-field cron (minute hour day-of-month month day-of-week) evaluated in an
 * IANA timezone, so "0 9 * * mon" means 9am local time across DST changes.
 */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Standard cron: when both day fields are restricted, either may match */
  dayOr: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const PRESETS: { [name: string]: string } = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
};

const parseField = (
  field: string,
  min: number,
  max: number,
  names: string[] = [],
  nameOffset = 0
): Set<number> => {
  const values = new Set<number>();
  const toNumber = (token: string): number => {
    const index = names.indexOf(token.toLowerCase());
    const value = index >= 0 ? index + nameOffset : Number(token);

    if (!/^\d+$/.test(String(value)) || value < min || value > max) {
      throw new Error(`"${token}" is out of range ${min}-${max}`);
    }

    return value;
  };

  field.split(',').forEach(part => {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);

    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Bad step "${stepText}"`);
    }

    let start: number;
    let end: number;

    if (range === '*') {
      start = min;
      end = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      start = toNumber(a);
      end = toNumber(b);

      if (start > end) {
        throw new Error(`Range "${range}" runs backwards`);
      }
    } else {
      start = toNumber(range);
      end = stepText === undefined ? start : max;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  });

  return values;
};

export const parseCron = (expression: string): CronFields => {
  const trimmed = String(expression || '').trim().toLowerCase();
  const source = PRESETS[trimmed] || trimmed;
  const parts = source.split(/\s+/);

  if (parts.length !== 5) {
    throw new Error('Use five fields: minute hour day-of-month month day-of-week');
  }

  const [minute, hour, day, month, weekday] = parts;
  const weekdays = parseField(weekday, 0, 7, WEEKDAYS);

  // 7 is also Sunday
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }

  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    days: parseField(day, 1, 31),
    months: parseField(month, 1, 12, MONTHS, 1),
    weekdays,
    dayOr: day !== '*' && weekday !== '*'
  };
};

export const isValidTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const localParts = (date: Date, timezone: string) => {
  let formatter = formatters.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short'
    });
    formatters.set(timezone, formatter);
  }

  const parts: { [type: string]: string } = {};
  formatter.formatToParts(date).forEach(part => {
    parts[part.type] = part.value;
  });

  return {
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(String(parts.weekday).slice(0, 3).toLowerCase())
  };
};

const MINUTE = 60_000;

/**
 * The first matching minute strictly after `after`, or null if none within
 * about five years (e.g. "0 0 31 2 *").
 */
export const nextCronTime = (expression: string, timezone: string, after: Date): Date | null => {
  const cron = parseCron(expression);
  let time = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const limit = time + 5 * 366 * 24 * 60 * MINUTE;

  while (time < limit) {
    const local = localParts(new Date(time), timezone);
    const dayMatches = cron.dayOr
      ? cron.days.has(local.day) || cron.weekdays.has(local.weekday)
      : cron.days.has(local.day) && cron.weekdays.has(local.weekday);

    if (!cron.months.has(local.month) || !dayMatches) {
      // Next local midnight (DST shifts are caught by the next checks)
      time += (24 * 60 - (local.hour * 60 + local.minute)) * MINUTE;
      continue;
    }

    if (!cron.hours.has(local.hour)) {
      time += (60 - local.minute) * MINUTE;
      continue;
    }

    if (!cron.minutes.has(local.minute)) {
      time += MINUTE;
      continue;
    }

    return new Date(time);
  }

  return null;
};

export const nextCronTimes = (
  expression: string,
  timezone: string,
  after: Date,
  count: number
): Date[] => {
  const times: Date[] = [];
  let cursor = after;

  while (times.length < count) {
    const next = nextCronTime(expression, timezone, cursor);

    if (!next) {
      break;
    }

    times.push(next);
    cursor = next;
  }

  return times;
};
