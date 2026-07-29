import {
  type DateRange,
  hasDateRange,
  isDateInRange,
  localDateForSlackTs,
  shiftLocalDate,
} from '../date-range.js';
import { logger } from '../logger.js';
import { findMatchesDetailed } from '../matching/matchers.js';
import { createRedactor } from '../redaction.js';
import { readSlacrawlDirectoryFromSource } from '../slacrawl/directory.js';
import {
  openSlacrawlDatabase,
  readLatestCursor,
  readMessagesSince,
  type SlacrawlDatabase,
} from '../slacrawl/slacrawl-db.js';
import { expandEvidence } from '../state/context.js';
import {
  latestSuccessfulImplicitRun,
  openStateStore,
  type RunWindow,
  readPreviousMemory,
  type StateStore,
} from '../state/state-store.js';
import type {
  EvidenceMessage,
  KnownUser,
  MatchDiagnostic,
  MatchResult,
  ResolvedConfig,
  SlackMessage,
} from '../types.js';
import { resolveLocalTimeZone } from '../utils/local-time.js';

export type PreparedAnalysisRuntime = {
  readonly topicId: string;
  readonly workspaceId: string | null;
  readonly inputMessageCount: number;
  readonly matchedMessageCount: number;
  readonly evidenceMessageCount: number;
  readonly executionMode: RunWindow['executionMode'];
  readonly requestedRange?: DateRange | undefined;
  readonly scanStartCursor: string | null;
  readonly scanEndCursor: string | null;
  readonly messages: readonly SlackMessage[];
  readonly matches: readonly MatchResult[];
  readonly diagnostics: readonly MatchDiagnostic[];
  readonly evidence: readonly EvidenceMessage[];
  readonly previousMemory: string | null;
  readonly localTimeZone: string;
  readonly knownUsers: readonly KnownUser[];
  readonly reason?: 'no_matches' | 'no_evidence_in_date_range' | undefined;
};

export async function prepareAnalysisRuntime(
  resolved: ResolvedConfig,
  options: { readonly dateRange?: DateRange | undefined } = {},
): Promise<PreparedAnalysisRuntime> {
  const { config, topicId } = resolved;
  const localTimeZone = resolveLocalTimeZone();
  const redactor = createRedactor(config.redaction);
  const store = openStateStore(config.storage.statePath, topicId);
  const source = openSlacrawlDatabase(config.storage.slacrawlDatabasePath, {
    redactMessage: redactor.redactMessage,
  });

  try {
    const workspaceId = source.workspaceId;
    const knownUsers = readSlacrawlDirectoryFromSource(source, config.channels).users;
    const channelIds = config.channels.map((channel) => channel.id);
    const runWindow = resolveRunWindow({
      source,
      channelIds,
      store,
      localTimeZone,
      dateRange: options.dateRange,
    });
    const messages = readMessagesSince(source, {
      channelIds,
      afterCursor: runWindow.scanStartCursor,
      beforeOrAtCursor: runWindow.scanEndCursor,
    });
    const logContext = { workspaceId };
    const matchDetails = await findMatchesDetailed(messages, config, logContext);
    const matches = filterMatchesByDateRange(
      matchDetails.matches,
      options.dateRange,
      localTimeZone,
    );
    const diagnostics = filterDiagnosticsByDateRange(
      matchDetails.diagnostics,
      options.dateRange,
      localTimeZone,
    );

    if (matches.length === 0) {
      return {
        topicId,
        workspaceId,
        inputMessageCount: messages.length,
        matchedMessageCount: 0,
        evidenceMessageCount: 0,
        executionMode: runWindow.executionMode,
        requestedRange: runWindow.requestedRange,
        scanStartCursor: runWindow.scanStartCursor,
        scanEndCursor: runWindow.scanEndCursor,
        messages,
        matches,
        diagnostics,
        evidence: [],
        previousMemory: readRedactedPreviousMemory(store, runWindow, redactor.redactText),
        localTimeZone,
        knownUsers,
        reason: 'no_matches',
      };
    }

    const rawEvidence = await expandEvidence(source, matches, config, logContext);
    const evidence = filterEvidenceByDateRange(rawEvidence, options.dateRange, localTimeZone);

    logger.info(
      {
        topicId,
        workspaceId,
        evidenceMessageCount: evidence.length,
        rawEvidenceMessageCount: rawEvidence.length,
        dateRange: options.dateRange,
      },
      'analysis runtime evidence prepared',
    );

    return {
      topicId,
      workspaceId,
      inputMessageCount: messages.length,
      matchedMessageCount: matches.length,
      evidenceMessageCount: evidence.length,
      executionMode: runWindow.executionMode,
      requestedRange: runWindow.requestedRange,
      scanStartCursor: runWindow.scanStartCursor,
      scanEndCursor: runWindow.scanEndCursor,
      messages,
      matches,
      diagnostics,
      evidence,
      previousMemory: readRedactedPreviousMemory(store, runWindow, redactor.redactText),
      localTimeZone,
      knownUsers,
      ...(evidence.length === 0 ? { reason: 'no_evidence_in_date_range' as const } : {}),
    };
  } finally {
    source.close();
  }
}

export function filterMatchesByDateRange(
  matches: readonly MatchResult[],
  dateRange: DateRange | undefined,
  localTimeZone: string,
): readonly MatchResult[] {
  if (!hasDateRange(dateRange)) {
    return matches;
  }

  return matches.filter((match) =>
    isSlackMessageInDateRange(match.message, dateRange, localTimeZone),
  );
}

function filterDiagnosticsByDateRange(
  diagnostics: readonly MatchDiagnostic[],
  dateRange: DateRange | undefined,
  localTimeZone: string,
): readonly MatchDiagnostic[] {
  if (!hasDateRange(dateRange)) {
    return diagnostics;
  }

  return diagnostics.filter((diagnostic) =>
    isSlackMessageInDateRange(diagnostic.message, dateRange, localTimeZone),
  );
}

function isSlackMessageInDateRange(
  message: SlackMessage,
  dateRange: DateRange | undefined,
  localTimeZone: string,
): boolean {
  return isDateInRange(localDateForSlackTs(message.ts, localTimeZone), dateRange);
}

export function resolveRunWindow(input: {
  readonly source: SlacrawlDatabase;
  readonly channelIds: readonly string[];
  readonly store: StateStore;
  readonly localTimeZone: string;
  readonly dateRange?: DateRange | undefined;
}): RunWindow {
  if (hasDateRange(input.dateRange)) {
    return {
      executionMode: 'explicit',
      requestedRange: input.dateRange,
      scanStartCursor: explicitRangeStartCursor(input.dateRange, input.localTimeZone),
      scanEndCursor: explicitRangeEndCursor(
        input.source,
        input.channelIds,
        input.dateRange,
        input.localTimeZone,
      ),
    };
  }

  const scanStartCursor =
    latestSuccessfulImplicitRun(input.store)?.scanEndCursor ??
    todayStartCursor(input.localTimeZone);
  return {
    executionMode: 'implicit',
    scanStartCursor,
    scanEndCursor: clampScanEndCursor(
      scanStartCursor,
      readLatestCursor(input.source, input.channelIds),
    ),
  };
}

export function todayStartCursor(timeZone: string, now: Date = new Date()): string {
  return ((localDayStartMilliseconds(now, timeZone) - 1) / 1000).toFixed(3);
}

export function explicitRangeStartCursor(
  dateRange: DateRange | undefined,
  timeZone: string,
): string | null {
  const startDate = dateRange?.startDate;
  if (!startDate) {
    return null;
  }

  return localDateBoundaryCursor(startDate, timeZone);
}

export function explicitRangeEndCursor(
  source: SlacrawlDatabase,
  channelIds: readonly string[],
  dateRange: DateRange | undefined,
  timeZone: string,
): string | null {
  if (!dateRange?.endDate) {
    return readLatestCursor(source, channelIds);
  }

  return localDateBoundaryCursor(shiftLocalDate(dateRange.endDate, 1), timeZone);
}

function localDateBoundaryCursor(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid local date boundary: ${date}`);
  }

  return (
    (localDateTimeMilliseconds({
      timeZone,
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0,
    }) -
      1) /
    1000
  ).toFixed(3);
}

function clampScanEndCursor(
  scanStartCursor: string | null,
  scanEndCursor: string | null,
): string | null {
  if (scanStartCursor === null || scanEndCursor === null) {
    return scanEndCursor ?? scanStartCursor;
  }
  return Number(scanEndCursor) < Number(scanStartCursor) ? scanStartCursor : scanEndCursor;
}

function localDayStartMilliseconds(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = readDatePart(parts, 'year');
  const month = readDatePart(parts, 'month');
  const day = readDatePart(parts, 'day');

  return localDateTimeMilliseconds({
    timeZone,
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: 0,
    minute: 0,
    second: 0,
  });
}

function localDateTimeMilliseconds(input: {
  readonly timeZone: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}): number {
  let utcMilliseconds = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
  );

  for (let index = 0; index < 3; index += 1) {
    const offset = localOffsetMinutes(new Date(utcMilliseconds), input.timeZone);
    const next =
      Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second) -
      offset * 60_000;
    if (next === utcMilliseconds) {
      return next;
    }
    utcMilliseconds = next;
  }

  return utcMilliseconds;
}

function localOffsetMinutes(date: Date, timeZone: string): number {
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
  const localTimeAsUtc = Date.UTC(
    Number(readDatePart(parts, 'year')),
    Number(readDatePart(parts, 'month')) - 1,
    Number(readDatePart(parts, 'day')),
    Number(readDatePart(parts, 'hour')),
    Number(readDatePart(parts, 'minute')),
    Number(readDatePart(parts, 'second')),
  );

  return Math.round((localTimeAsUtc - date.getTime()) / 60_000);
}

function readDatePart(parts: readonly Intl.DateTimeFormatPart[], type: string): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Unable to format local date part "${type}"`);
  }

  return value;
}

export function maxCursor(messages: readonly { readonly ts: string }[]): string | null {
  let max: number | null = null;
  let fallback: string | null = null;

  for (const message of messages) {
    const numeric = Number(message.ts);
    if (Number.isFinite(numeric)) {
      max = max === null ? numeric : Math.max(max, numeric);
    } else {
      fallback = message.ts;
    }
  }

  return max === null ? fallback : String(max);
}

export function filterEvidenceByDateRange(
  evidence: readonly EvidenceMessage[],
  dateRange: DateRange | undefined,
  localTimeZone: string,
): readonly EvidenceMessage[] {
  if (!hasDateRange(dateRange)) {
    return evidence;
  }

  return evidence.filter((message) =>
    isDateInRange(localDateForSlackTs(message.ts, localTimeZone), dateRange),
  );
}

function readRedactedPreviousMemory(
  store: StateStore,
  window: RunWindow,
  redactText: (text: string) => string,
): string | null {
  const previousMemory = readPreviousMemory(store, window);
  return previousMemory === null ? null : redactText(previousMemory);
}
