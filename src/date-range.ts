import { resolveLocalTimeZone } from './utils/local-time.js';

export type DateRange = {
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
};

export type DateWindow = 'current-workday' | 'previous-workday' | 'previous-5-workdays';

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

export function normalizeDateRange(
  input: DateRange & { readonly date?: string | undefined; readonly window?: string | undefined },
  localTimeZone?: string,
  now: Date = new Date(),
): DateRange {
  validateDate('date', input.date);
  validateDate('start-date', input.startDate);
  validateDate('end-date', input.endDate);
  validateExclusiveRangeInput(input);

  const resolvedDate = input.date
    ? resolveDateAlias(input.date, localTimeZone ?? resolveLocalTimeZone(), now)
    : undefined;
  const resolvedWindow = input.window
    ? resolveDateWindow(input.window, localTimeZone ?? resolveLocalTimeZone(), now)
    : undefined;
  const startDate = resolvedWindow?.startDate ?? resolvedDate ?? input.startDate;
  const endDate = resolvedWindow?.endDate ?? resolvedDate ?? input.endDate;

  if (startDate && endDate && startDate > endDate) {
    throw new Error(`Invalid date range: start date ${startDate} is after end date ${endDate}`);
  }

  return {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
}

export function localDateForDate(date: Date, timeZone: string): string {
  // en-CA keeps local date parts aligned with the YYYY-MM-DD contract used by CLI date ranges.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return `${readPart(parts, 'year')}-${readPart(parts, 'month')}-${readPart(parts, 'day')}`;
}

export function shiftLocalDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function hasDateRange(range: DateRange | undefined): boolean {
  return Boolean(range?.startDate || range?.endDate);
}

export function isDateInRange(date: string, range: DateRange | undefined): boolean {
  if (!range) {
    return true;
  }

  return (!range.startDate || date >= range.startDate) && (!range.endDate || date <= range.endDate);
}

export function localDateForSlackTs(ts: string, timeZone: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    throw new Error(`Cannot derive local date from non-numeric Slack timestamp: ${ts}`);
  }

  return localDateForDate(new Date(seconds * 1000), timeZone);
}

function validateExclusiveRangeInput(
  input: DateRange & { readonly date?: string | undefined; readonly window?: string | undefined },
): void {
  if (input.window !== undefined && (input.date || input.startDate || input.endDate)) {
    throw new Error('--window is mutually exclusive with --date, --start-date, and --end-date');
  }

  if (input.date !== undefined && (input.startDate || input.endDate)) {
    throw new Error('--date is mutually exclusive with --start-date and --end-date');
  }
}

function resolveDateAlias(value: string, localTimeZone: string, now: Date): string {
  if (datePattern.test(value)) {
    return value;
  }

  const today = localDateForDate(now, localTimeZone);
  if (value === 'today') {
    return today;
  }

  if (value === 'yesterday') {
    return shiftLocalDate(today, -1);
  }

  throw new Error(`Invalid date: expected YYYY-MM-DD, today, or yesterday, received ${value}`);
}

function resolveDateWindow(value: string, localTimeZone: string, now: Date): DateRange {
  if (!isDateWindow(value)) {
    throw new Error(
      `Invalid window: expected current-workday, previous-workday, or previous-5-workdays, received ${value}`,
    );
  }

  const today = localDateForDate(now, localTimeZone);
  if (value === 'current-workday') {
    const date = currentWorkday(today);
    return { startDate: date, endDate: date };
  }

  if (value === 'previous-workday') {
    const date = previousWorkday(today);
    return { startDate: date, endDate: date };
  }

  const endDate = currentWorkday(today);
  return {
    startDate: nthPreviousWorkdayInclusive(endDate, 5),
    endDate,
  };
}

function validateDate(name: string, value: string | undefined): void {
  if (value === undefined || name === 'date') {
    return;
  }

  if (!datePattern.test(value)) {
    throw new Error(`Invalid ${name}: expected YYYY-MM-DD, received ${value}`);
  }
}

function isDateWindow(value: string): value is DateWindow {
  return (
    value === 'current-workday' || value === 'previous-workday' || value === 'previous-5-workdays'
  );
}

function currentWorkday(date: string): string {
  return isWorkday(date) ? date : previousWorkday(date);
}

function previousWorkday(date: string): string {
  let cursor = shiftLocalDate(date, -1);
  while (!isWorkday(cursor)) {
    cursor = shiftLocalDate(cursor, -1);
  }
  return cursor;
}

function nthPreviousWorkdayInclusive(date: string, count: number): string {
  let cursor = date;
  let remaining = count - 1;
  while (remaining > 0) {
    cursor = previousWorkday(cursor);
    remaining -= 1;
  }
  return cursor;
}

function isWorkday(date: string): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function readPart(parts: readonly Intl.DateTimeFormatPart[], type: string): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Unable to format local date part "${type}"`);
  }

  return value;
}
