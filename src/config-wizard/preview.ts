import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { localDateForSlackTs } from '../date-range.js';
import type { PreparedAnalysisRuntime } from '../runtime/analysis.js';
import type { ChannelConfig, EvidenceMessage, MatchDiagnostic, SlackMessage } from '../types.js';

const marked = new Marked();
marked.use(markedTerminal());

export function formatMatchPreview(prepared: PreparedAnalysisRuntime): string {
  const lines = [
    chalk.bold('Match preview'),
    `Scanned: ${prepared.inputMessageCount}`,
    `Matched anchors: ${prepared.matchedMessageCount}`,
    `Evidence messages: ${prepared.evidenceMessageCount}`,
    '',
    chalk.bold('Matched anchors'),
    ...formatMatchedDiagnostics(prepared.diagnostics, prepared.localTimeZone),
    '',
    chalk.bold('Evidence'),
    ...formatEvidence(prepared.evidence, prepared.diagnostics, prepared.localTimeZone),
    '',
    chalk.bold('Ignored'),
    ...formatIgnoredDiagnostics(prepared.diagnostics, prepared.localTimeZone),
  ];
  return `${lines.join('\n')}\n`;
}

export function renderMarkdownReport(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

function formatMatchedDiagnostics(
  diagnostics: readonly MatchDiagnostic[],
  localTimeZone: string,
): readonly string[] {
  const matched = diagnostics.filter((diagnostic) => diagnostic.matched);
  if (matched.length === 0) {
    return [chalk.dim('No matched anchor messages.')];
  }

  return formatGroupedMessages(
    matched.slice(0, 30),
    (diagnostic) => diagnostic.message,
    (diagnostic) => diagnostic.channel,
    (diagnostic) => formatMatchReason(diagnostic),
    userNamesFromDiagnostics(diagnostics),
    localTimeZone,
  );
}

function formatIgnoredDiagnostics(
  diagnostics: readonly MatchDiagnostic[],
  localTimeZone: string,
): readonly string[] {
  const ignored = diagnostics.filter((diagnostic) => !diagnostic.matched);
  if (ignored.length === 0) {
    return [chalk.dim('No ignored messages in scanned input.')];
  }

  return formatGroupedMessages(
    ignored.slice(0, 30),
    (diagnostic) => diagnostic.message,
    (diagnostic) => diagnostic.channel ?? { id: diagnostic.message.channelId },
    (diagnostic) => formatIgnoredReason(diagnostic),
    userNamesFromDiagnostics(diagnostics),
    localTimeZone,
  );
}

function formatEvidence(
  evidence: readonly EvidenceMessage[],
  diagnostics: readonly MatchDiagnostic[],
  localTimeZone: string,
): readonly string[] {
  if (evidence.length === 0) {
    return [chalk.dim('No evidence messages would be sent to the model.')];
  }

  const channels = channelsFromDiagnostics(diagnostics);
  return formatGroupedMessages(
    evidence.slice(0, 50),
    (message) => message,
    (message) => channels.get(message.channelId) ?? { id: message.channelId },
    (message) => chalk.cyan(message.source.toUpperCase()),
    userNamesFromDiagnostics(diagnostics),
    localTimeZone,
  );
}

function formatGroupedMessages<T>(
  items: readonly T[],
  messageFor: (item: T) => SlackMessage,
  channelFor: (item: T) => ChannelConfig,
  reasonFor: (item: T) => string,
  userNames: ReadonlyMap<string, string>,
  localTimeZone: string,
): readonly string[] {
  const lines: string[] = [];
  let previousChannelId: string | undefined;
  let previousDate: string | undefined;
  for (const item of items) {
    const message = messageFor(item);
    const channel = channelFor(item);
    if (channel.id !== previousChannelId) {
      lines.push(formatChannelHeader(channel));
      previousChannelId = channel.id;
      previousDate = undefined;
    }

    const date = formatDate(message.ts, localTimeZone);
    if (date !== previousDate) {
      lines.push(chalk.bold(date));
      previousDate = date;
    }

    lines.push(
      `  ${formatTime(message.ts, localTimeZone)} ${reasonFor(item)} ${formatUser(
        message,
        userNames,
      )}: ${chalk.dim(trimMessage(message.text))}`,
    );
  }
  return lines;
}

function formatChannelHeader(channel: ChannelConfig): string {
  return chalk.bold(
    channel.name ? `Channel ${channel.id} (#${channel.name})` : `Channel ${channel.id}`,
  );
}

function formatDate(ts: string, localTimeZone: string): string {
  return localDateForSlackTs(ts, localTimeZone);
}

function formatTime(ts: string, localTimeZone: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    return '??:??';
  }
  // Keep preview time formatting on the same locale convention as local date formatting.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: localTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(seconds * 1000));
  return `${readPart(parts, 'hour')}:${readPart(parts, 'minute')}`;
}

function readPart(parts: readonly Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((part) => part.type === type)?.value ?? '??';
}

function formatMatchReason(
  diagnostic: Extract<MatchDiagnostic, { readonly matched: true }>,
): string {
  return chalk.green(`MATCH ${diagnostic.matcherType}:${diagnostic.matcherId}`);
}

function formatIgnoredReason(
  diagnostic: Extract<MatchDiagnostic, { readonly matched: false }>,
): string {
  const matcher = diagnostic.matcherId ? ` ${diagnostic.matcherType}:${diagnostic.matcherId}` : '';
  return chalk.yellow(`IGNORE ${diagnostic.reason}${matcher}`);
}

function formatUser(message: SlackMessage, userNames: ReadonlyMap<string, string>): string {
  if (!message.userId) {
    return 'unknown user';
  }
  const name = userNames.get(message.userId);
  return name ? `${name} (${message.userId})` : message.userId;
}

function userNamesFromDiagnostics(
  diagnostics: readonly MatchDiagnostic[],
): ReadonlyMap<string, string> {
  const users = new Map<string, string>();
  for (const diagnostic of diagnostics) {
    for (const user of diagnostic.channel?.users ?? []) {
      if (user.name) {
        users.set(user.id, user.name);
      }
    }
  }
  return users;
}

function channelsFromDiagnostics(
  diagnostics: readonly MatchDiagnostic[],
): ReadonlyMap<string, ChannelConfig> {
  const channels = new Map<string, ChannelConfig>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.channel) {
      channels.set(diagnostic.channel.id, diagnostic.channel);
    }
  }
  return channels;
}

function trimMessage(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, 180);
}
