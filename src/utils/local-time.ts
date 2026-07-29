import process from 'node:process';
import { logger } from '../logger.js';

export function resolveLocalTimeZone(): string {
  // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111 (noPropertyAccessFromIndexSignature).
  const timeZone = process.env['TZ'];
  if (timeZone) {
    return timeZone;
  }

  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  logger.warn({ fallbackTimeZone: fallback }, 'TZ is unset; using system local timezone');
  return fallback;
}

export function formatDateForLlm(date: Date, timeZone: string): string {
  const parts = localDateParts(date, timeZone);
  const offsetMinutes = localOffsetMinutes(date, timeZone);
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainderMinutes = absoluteOffset % 60;

  return `${parts.year}${parts.month}${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetSign}${pad(offsetHours)}${pad(offsetRemainderMinutes)}`;
}

export function formatSlackTimestampForLlm(ts: string, timeZone: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    return ts;
  }

  return formatDateForLlm(new Date(seconds * 1000), timeZone);
}

export function formatDateStringForLlm(value: string, timeZone: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return value;
  }

  return formatDateForLlm(new Date(milliseconds), timeZone);
}

function localOffsetMinutes(date: Date, timeZone: string): number {
  const parts = localDateParts(date, timeZone);
  const localTimeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return Math.round((localTimeAsUtc - date.getTime()) / 60000);
}

function localDateParts(
  date: Date,
  timeZone: string,
): {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return {
    year: readPart(parts, 'year'),
    month: readPart(parts, 'month'),
    day: readPart(parts, 'day'),
    hour: readPart(parts, 'hour'),
    minute: readPart(parts, 'minute'),
    second: readPart(parts, 'second'),
  };
}

function readPart(parts: readonly Intl.DateTimeFormatPart[], type: string): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Unable to format local timestamp part "${type}"`);
  }

  return value;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
