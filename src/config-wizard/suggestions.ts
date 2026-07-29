import { type GenerateModelText, generateModelText } from '../llm/generate.js';
import type { AppConfig } from '../types.js';

export type ScoredMatcherSuggestion = {
  readonly question: string;
  readonly keywords: readonly string[];
  readonly phrases: readonly string[];
  readonly patterns: readonly string[];
};

export async function suggestScoredMatcher(
  config: AppConfig,
  input: {
    readonly relevantSamples: readonly string[];
    readonly irrelevantSamples: readonly string[];
  },
  generateText: GenerateModelText = generateModelText,
): Promise<ScoredMatcherSuggestion> {
  const output = await generateText({
    config,
    system: [
      'You help configure deterministic Slack message matching.',
      'Return only strict JSON. Do not include markdown fences.',
    ].join(' '),
    prompt: [
      'Given relevant and irrelevant Slack message samples, propose a scored matcher configuration.',
      'Return this exact JSON shape:',
      '{"question":"...","keywords":["..."],"phrases":["..."],"patterns":["..."]}',
      'Patterns must be JavaScript RegExp pattern sources, without flags.',
      '',
      'Relevant samples:',
      JSON.stringify(input.relevantSamples),
      '',
      'Irrelevant samples:',
      JSON.stringify(input.irrelevantSamples),
    ].join('\n'),
  });

  return parseScoredMatcherSuggestion(output.text);
}

export function parseScoredMatcherSuggestion(text: string): ScoredMatcherSuggestion {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Scored matcher suggestion must be a JSON object');
  }

  const source = parsed as Record<string, unknown>;
  return {
    question: readString(source, 'question'),
    keywords: readStringArray(source, 'keywords'),
    phrases: readStringArray(source, 'phrases'),
    patterns: readStringArray(source, 'patterns'),
  };
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Scored matcher suggestion is missing string field "${key}"`);
  }
  return value.trim();
}

function readStringArray(source: Record<string, unknown>, key: string): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Scored matcher suggestion is missing string array field "${key}"`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}
