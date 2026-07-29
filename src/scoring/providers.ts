import { embed, generateText } from 'ai';
import { logger } from '../logger.js';
import { createEmbeddingModel, createLanguageModel } from '../providers.js';
import type { ClassifierConfig, EmbeddingsConfig, SyntheticScoreRange } from '../types.js';

const defaultEmbeddingModel = 'nomic-embed-text';
const defaultClassifierModel = 'qwen3:0.6b';
const defaultTimeoutMs = 120_000;

export async function embedText(
  text: string,
  config: EmbeddingsConfig,
): Promise<readonly number[]> {
  const provider = config.provider ?? 'ollama';
  const model = config.model ?? defaultEmbeddingModel;
  const timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
  logger.info(
    {
      provider,
      model,
      baseUrl: config.baseUrl,
      timeoutMs,
      inputLength: text.length,
    },
    'embedding AI SDK provider call started',
  );

  const { embedding } = await withAbortSignal(timeoutMs, (abortSignal) =>
    embed({
      model: createEmbeddingModel({ provider, model, baseUrl: config.baseUrl }),
      value: text,
      abortSignal,
    }),
  );

  return embedding;
}

export async function classifyWithProvider(
  prompt: string,
  config: ClassifierConfig,
): Promise<SyntheticScoreRange> {
  const provider = config.provider ?? 'ollama';
  const model = config.model ?? defaultClassifierModel;
  const timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
  logger.info(
    {
      provider,
      model,
      baseUrl: config.baseUrl,
      timeoutMs,
      promptLength: prompt.length,
      temperature: 0,
    },
    'classifier AI SDK provider call started',
  );

  const { text } = await withAbortSignal(timeoutMs, (abortSignal) =>
    generateText({
      model: createLanguageModel({ provider, model, baseUrl: config.baseUrl }),
      prompt,
      ...(modelSupportsTemperature({ provider, model }) ? { temperature: 0 } : {}),
      abortSignal,
    }),
  );

  const range = parseRange(text);
  logger.info({ provider, model, range }, 'classifier AI SDK provider call finished');
  return range;
}

async function withAbortSignal<T>(
  timeoutMs: number,
  callback: (abortSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await callback(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))));
}

export function mergeEmbeddingsConfig(
  defaults: EmbeddingsConfig | undefined,
  override: EmbeddingsConfig | undefined,
): EmbeddingsConfig | undefined {
  return mergeProviderConfig(defaults, override);
}

export function mergeClassifierConfig(
  defaults: ClassifierConfig | undefined,
  override: ClassifierConfig | undefined,
): ClassifierConfig | undefined {
  return mergeProviderConfig(defaults, override);
}

function mergeProviderConfig<T extends object>(
  defaults: T | undefined,
  override: T | undefined,
): T | undefined {
  if (!defaults && !override) {
    return undefined;
  }

  return { ...(defaults ?? {}), ...(override ?? {}) } as T;
}

function parseRange(text: string): SyntheticScoreRange {
  const normalized = text.toLowerCase();
  if (/\brelated\b/.test(normalized) && !/\bunrelated\b/.test(normalized)) {
    return 'related';
  }

  if (/\bambiguous\b/.test(normalized)) {
    return 'ambiguous';
  }

  if (/\bunrelated\b/.test(normalized)) {
    return 'unrelated';
  }

  throw new Error(
    `Classifier response must include one of related, ambiguous, or unrelated. Response: ${text}`,
  );
}

function modelSupportsTemperature(modelConfig: {
  readonly model: string;
  readonly provider: string;
}): boolean {
  const provider = modelConfig.provider.toLowerCase();
  const model = modelConfig.model.toLowerCase();
  if (!['openai', 'openai-compatible', 'openrouter', 'gateway'].includes(provider)) {
    return true;
  }

  return !/^(?:gpt-5(?:[.-]|$)|o\d+(?:[.-]|$))/.test(model);
}
