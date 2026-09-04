/**
 * Reporting periods in the shop owner's local time.
 *
 * "Today" means today in Lagos, not today in UTC. Getting this wrong makes the
 * evening's sales land in tomorrow's report, which is the kind of error that
 * looks like the numbers are simply wrong.
 *
 * Nigeria is UTC+1 year round with no daylight saving, so a fixed offset is
 * correct rather than merely convenient. If this ever needs another market,
 * replace the constant with a real timezone conversion.
 */

const LAGOS_OFFSET_MINUTES = 60;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export type Period = 'today' | 'week' | 'month';

export interface PeriodRange {
  from: Date;
  to: Date;
  label: string;
}

/** The same instant, shifted so UTC getters read as Lagos wall-clock time. */
function toLagos(date: Date): Date {
  return new Date(date.getTime() + LAGOS_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** Inverse of toLagos: a Lagos wall-clock time back to a real instant. */
function fromLagos(date: Date): Date {
  return new Date(date.getTime() - LAGOS_OFFSET_MINUTES * MS_PER_MINUTE);
}

function lagosMidnight(date: Date): Date {
  const local = toLagos(date);
  return fromLagos(
    new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())),
  );
}

export function periodRange(period: Period, now: Date = new Date()): PeriodRange {
  const startOfToday = lagosMidnight(now);
  const endOfToday = new Date(startOfToday.getTime() + MS_PER_DAY);

  switch (period) {
    case 'today':
      return { from: startOfToday, to: endOfToday, label: 'Today' };

    case 'week': {
      // Rolling seven days ending tonight, not an ISO week. A shop owner asking
      // "this week" on a Wednesday means the last seven days of trading.
      return {
        from: new Date(startOfToday.getTime() - 6 * MS_PER_DAY),
        to: endOfToday,
        label: 'Last 7 days',
      };
    }

    case 'month': {
      const local = toLagos(now);
      const from = fromLagos(new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1)));
      const monthName = new Intl.DateTimeFormat('en-NG', {
        month: 'long',
        timeZone: 'Africa/Lagos',
      }).format(now);
      return { from, to: endOfToday, label: monthName };
    }
  }
}
