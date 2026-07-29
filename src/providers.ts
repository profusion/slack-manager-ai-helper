import process from 'node:process';
import { anthropic } from '@ai-sdk/anthropic';
import { gateway } from '@ai-sdk/gateway';
import { google } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { xai } from '@ai-sdk/xai';
import type { OpenRouterChatSettings } from '@openrouter/ai-sdk-provider';
import { openrouter } from '@openrouter/ai-sdk-provider';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { opencode } from 'ai-sdk-provider-opencode-sdk';
import { createOllama } from 'ollama-ai-provider-v2';

export type ProviderFactory = (model: string) => LanguageModel;
export type EmbeddingProviderFactory = (model: string) => EmbeddingModel;

export type LlmConfig = {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string | undefined;
  readonly openrouter?:
    | {
        readonly includeReasoning?: boolean | undefined;
        readonly order?: readonly string[] | undefined;
        readonly allowFallbacks?: boolean | undefined;
      }
    | undefined;
};

export type LlmProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'openrouter'
  | 'opencode'
  | 'openai-compatible'
  | 'gateway'
  | 'ollama';

type AiSdkProvider = {
  readonly languageModel: ProviderFactory;
  readonly embeddingModel?: EmbeddingProviderFactory | undefined;
};

const builtInFactories: Record<LlmProvider, (config: LlmConfig) => AiSdkProvider> = {
  openai: () => ({
    languageModel: (model) => openai(model),
    embeddingModel: (model) => openai.embeddingModel(model),
  }),
  anthropic: () => ({
    languageModel: (model) => anthropic(model),
  }),
  google: () => ({
    languageModel: (model) => google(model),
    embeddingModel: (model) => google.embeddingModel(model),
  }),
  xai: () => ({
    languageModel: (model) => xai(model),
  }),
  openrouter: (config) => ({
    languageModel: (model) => {
      const settings = openRouterChatSettings(config);
      return settings === undefined ? openrouter(model) : openrouter(model, settings);
    },
    embeddingModel: (model) => openrouter.textEmbeddingModel(model),
  }),
  opencode: () => ({
    languageModel: (model) => opencode(model),
  }),
  'openai-compatible': (config) => {
    const provider = createOpenAI(config.baseUrl ? { baseURL: config.baseUrl } : undefined);
    return {
      languageModel: (model) => provider(model),
      embeddingModel: (model) => provider.embeddingModel(model),
    };
  },
  gateway: () => ({
    languageModel: (model) => gateway(model as Parameters<typeof gateway>[0]),
    embeddingModel: (model) =>
      gateway.embeddingModel(model as Parameters<typeof gateway.embeddingModel>[0]),
  }),
  ollama: (config) => {
    const provider = createOllama({ baseURL: ollamaBaseUrl(config) });
    return {
      languageModel: (model) => provider.completion(model),
      embeddingModel: (model) => provider.textEmbeddingModel(model),
    };
  },
};

export function createLanguageModel(llm: LlmConfig): LanguageModel {
  return createProvider(llm).languageModel(llm.model);
}

export function createEmbeddingModel(config: LlmConfig): EmbeddingModel {
  const provider = createProvider(config);
  if (!provider.embeddingModel) {
    throw new Error(`Provider "${config.provider}" does not support embeddings through AI SDK`);
  }

  return provider.embeddingModel(config.model);
}

export function supportedProviderIds(): readonly string[] {
  return Object.keys(builtInFactories);
}

function createProvider(config: LlmConfig): AiSdkProvider {
  const builtIn = builtInFactories[config.provider as LlmProvider];
  if (!builtIn) {
    throw new Error(
      `Unknown AI SDK provider "${config.provider}". Built-in: ${supportedProviderIds().join(', ')}`,
    );
  }

  return builtIn(config);
}

function ollamaBaseUrl(config: Pick<LlmConfig, 'baseUrl'>): string {
  const env: { readonly OLLAMA_URL?: string | undefined } = process.env;
  const baseUrl = config.baseUrl ?? env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/api') ? normalized : `${normalized}/api`;
}

function openRouterChatSettings(
  config: Pick<LlmConfig, 'openrouter'>,
): OpenRouterChatSettings | undefined {
  const settings: OpenRouterChatSettings = {};
  if (config.openrouter?.includeReasoning !== undefined) {
    settings.extraBody = {
      reasoning: {
        exclude: !config.openrouter.includeReasoning,
      },
    };
  }

  const provider = openRouterProviderSettings(config.openrouter);
  if (provider !== undefined) {
    settings.provider = provider;
  }

  return Object.keys(settings).length === 0 ? undefined : settings;
}

function openRouterProviderSettings(
  config: LlmConfig['openrouter'],
): NonNullable<OpenRouterChatSettings['provider']> | undefined {
  const provider: NonNullable<OpenRouterChatSettings['provider']> = {};
  if (config?.order !== undefined) {
    provider.order = [...config.order];
  }
  if (config?.allowFallbacks !== undefined) {
    provider.allow_fallbacks = config.allowFallbacks;
  }

  return Object.keys(provider).length === 0 ? undefined : provider;
}
