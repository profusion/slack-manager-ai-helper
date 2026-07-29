import { extractJsonMiddleware, generateText, jsonSchema, Output, wrapLanguageModel } from 'ai';
import { logger } from '../logger.js';
import { createLanguageModel } from '../providers.js';
import type { AppConfig } from '../types.js';

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

export type ModelUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly inputTokenDetails?:
    | {
        readonly noCacheTokens?: number | undefined;
        readonly cacheReadTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
      }
    | undefined;
  readonly outputTokenDetails?:
    | {
        readonly textTokens?: number | undefined;
        readonly reasoningTokens?: number | undefined;
      }
    | undefined;
  readonly raw?: unknown;
};

export type GenerateModelTextResult = {
  readonly text: string;
  readonly output?: unknown;
  readonly usage?: ModelUsage | undefined;
  readonly providerMetadata?: unknown;
};

export type GenerateModelText = (input: {
  readonly config: AppConfig;
  readonly system: string;
  readonly prompt: string;
  readonly outputSchema?: unknown | undefined;
}) => Promise<GenerateModelTextResult>;

export const generateModelText: GenerateModelText = async ({
  config,
  system,
  prompt,
  outputSchema,
}) => {
  const baseModel = createLanguageModel(config.model);
  const model =
    outputSchema === undefined
      ? baseModel
      : wrapLanguageModel({
          model: baseModel as Parameters<typeof wrapLanguageModel>[0]['model'],
          middleware: extractJsonMiddleware(),
        });
  const temperature = modelSupportsTemperature(config.model) ? config.model.temperature : undefined;
  if (config.model.temperature !== undefined && temperature === undefined) {
    logger.debug(
      {
        provider: config.model.provider,
        model: config.model.model,
        temperature: config.model.temperature,
      },
      'omitting temperature for reasoning model',
    );
  }

  const options = {
    model,
    system,
    prompt,
    ...(outputSchema === undefined
      ? {}
      : {
          output: Output.object({
            schema: jsonSchema(outputSchema),
            name: 'analysis_output',
            description: 'Structured analysis memory and markdown report.',
          }),
        }),
    ...(temperature === undefined ? {} : { temperature }),
    ...providerOptionsForModel(config.model),
    ...(config.model.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.model.maxOutputTokens }),
  };
  const result =
    config.model.timeoutMs === undefined
      ? await generateText(options)
      : await generateTextWithTimeout(options, config.model.timeoutMs);
  return {
    text: result.text,
    ...(outputSchema === undefined ? {} : { output: result.output }),
    usage: normalizeUsage(result.totalUsage ?? result.usage),
    providerMetadata: result.providerMetadata,
  };
};

async function generateTextWithTimeout(
  options: Parameters<typeof generateText>[0],
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await generateText({ ...options, abortSignal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function providerOptionsForModel(modelConfig: AppConfig['model']): {
  readonly providerOptions?: ProviderOptions;
} {
  const effort = modelConfig.reasoningEffort;
  if (effort === undefined) {
    return {};
  }

  switch (modelConfig.provider) {
    case 'anthropic':
      return { providerOptions: { anthropic: { effort } } };
    case 'openai-compatible':
      return { providerOptions: { openaiCompatible: { reasoningEffort: effort } } };
    case 'openrouter':
      return { providerOptions: { openrouter: { reasoning: { effort } } } };
    case 'xai':
      return { providerOptions: { xai: { reasoningEffort: effort } } };
    default:
      return { providerOptions: { [modelConfig.provider]: { reasoningEffort: effort } } };
  }
}

function normalizeUsage(usage: ModelUsage | undefined): ModelUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return stripUndefined({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens,
    inputTokenDetails: stripUndefined({
      noCacheTokens: usage.inputTokenDetails?.noCacheTokens,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
    }),
    outputTokenDetails: stripUndefined({
      textTokens: usage.outputTokenDetails?.textTokens,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    }),
    raw: usage.raw,
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries) as T;
}

export function modelSupportsTemperature(
  modelConfig: Pick<AppConfig['model'], 'model' | 'provider'>,
): boolean {
  return !isKnownReasoningModel(modelConfig);
}

function isKnownReasoningModel(
  modelConfig: Pick<AppConfig['model'], 'model' | 'provider'>,
): boolean {
  const provider = modelConfig.provider.toLowerCase();
  const model = modelConfig.model.toLowerCase();
  if (!['openai', 'openai-compatible', 'openrouter'].includes(provider)) {
    return false;
  }

  return /^(?:gpt-5(?:[.-]|$)|o\d+(?:[.-]|$))/.test(model);
}
