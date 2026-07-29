import type { AppConfig, EvidenceMessage, MatchResult, SlackMessage } from './types.js';

export type Redactor = {
  readonly redactText: (text: string) => string;
  readonly redactJson: (value: unknown) => unknown;
  readonly redactMessage: <T extends SlackMessage>(message: T) => T;
  readonly redactMatch: (match: MatchResult) => MatchResult;
  readonly redactEvidence: (message: EvidenceMessage) => EvidenceMessage;
};

type CompiledPattern = {
  readonly id: string;
  readonly regex: RegExp;
};

const defaultReplacement = '[REDACTED]';

// Pattern examples are informed by https://github.com/Trendyol/awesome-regex-list/blob/main/regexes.yml
const defaultPatterns: readonly CompiledPattern[] = [
  { id: 'bearer-token', regex: /Bearer\s+\S+/gu },
  { id: 'aws-access-key-id', regex: /\b(?:AKIA|ASIA|A3T|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/gu },
  { id: 'slack-token', regex: /\bxox[abceoprs]-[A-Za-z0-9-]{10,}\b/gu },
  {
    id: 'github-token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/gu,
  },
  {
    id: 'quoted-key-value',
    regex: /\bkey(?:.{0,20})?['"][0-9A-Za-z/+]{32,45}['"]/giu,
  },
  { id: 'high-entropy-alnum', regex: /\b[A-Za-z0-9]{32,}\b/gu },
];

export function createRedactor(config: AppConfig['redaction']): Redactor {
  const enabled = config?.enabled ?? true;
  const replacement = config?.replacement ?? defaultReplacement;
  const patterns = enabled
    ? [...defaultPatterns, ...compileAdditionalPatterns(config?.additionalPatterns ?? [])]
    : [];

  return {
    redactText: (text) => redactText(text, patterns, replacement),
    redactJson: (value) => redactJson(value, patterns, replacement),
    redactMessage: (message) => redactMessage(message, patterns, replacement),
    redactMatch: (match) => ({
      ...match,
      message: redactMessage(match.message, patterns, replacement),
    }),
    redactEvidence: (message) => redactMessage(message, patterns, replacement),
  };
}

function compileAdditionalPatterns(
  patterns: NonNullable<AppConfig['redaction']>['additionalPatterns'],
): readonly CompiledPattern[] {
  return (patterns ?? []).map((pattern) => ({
    id: pattern.id,
    regex: new RegExp(pattern.pattern, normalizeFlags(pattern.flags)),
  }));
}

function normalizeFlags(flags: string | undefined): string {
  const normalized = new Set((flags ?? 'gu').split(''));
  normalized.add('g');
  normalized.add('u');
  return [...normalized].join('');
}

function redactText(
  text: string,
  patterns: readonly CompiledPattern[],
  replacement: string,
): string {
  let redacted = text;
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    redacted = redacted.replace(pattern.regex, replacement);
  }
  return redacted;
}

function redactMessage<T extends SlackMessage>(
  message: T,
  patterns: readonly CompiledPattern[],
  replacement: string,
): T {
  return {
    ...message,
    text: redactText(message.text, patterns, replacement),
  };
}

function redactJson(
  value: unknown,
  patterns: readonly CompiledPattern[],
  replacement: string,
): unknown {
  if (typeof value === 'string') {
    return redactText(value, patterns, replacement);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, patterns, replacement));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item, patterns, replacement)]),
    );
  }

  return value;
}
