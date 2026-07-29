import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddingModel,
  createLanguageModel,
  supportedProviderIds,
} from '../src/providers.js';
import { classifyWithProvider, embedText } from '../src/scoring/providers.js';

const { embedMock, generateTextMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  generateTextMock: vi.fn(),
}));

const { openrouterMock, openrouterEmbeddingModelMock } = vi.hoisted(() => ({
  openrouterMock: vi.fn((model: string, settings?: unknown) => ({
    provider: 'openrouter',
    model,
    settings,
  })),
  openrouterEmbeddingModelMock: vi.fn((model: string) => ({
    provider: 'openrouter',
    model,
    embedding: true,
  })),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    embed: embedMock,
    generateText: generateTextMock,
  };
});

vi.mock('@openrouter/ai-sdk-provider', () => ({
  openrouter: Object.assign(openrouterMock, {
    textEmbeddingModel: openrouterEmbeddingModelMock,
  }),
}));

describe('AI SDK providers', () => {
  it('constructs language models for local and remote providers', () => {
    expect(createLanguageModel({ provider: 'ollama', model: 'qwen3:0.6b' })).toBeTruthy();
    expect(createLanguageModel({ provider: 'openai', model: 'gpt-4o-mini' })).toBeTruthy();
    expect(
      createLanguageModel({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }),
    ).toBeTruthy();
    expect(createLanguageModel({ provider: 'gateway', model: 'openai/gpt-4o-mini' })).toBeTruthy();
  });

  it('constructs embedding models for supported providers', () => {
    expect(createEmbeddingModel({ provider: 'ollama', model: 'nomic-embed-text' })).toBeTruthy();
    expect(
      createEmbeddingModel({ provider: 'openai', model: 'text-embedding-3-small' }),
    ).toBeTruthy();
    expect(
      createEmbeddingModel({ provider: 'gateway', model: 'openai/text-embedding-3-small' }),
    ).toBeTruthy();
  });

  it('does not send OpenRouter request settings when they are omitted', () => {
    openrouterMock.mockClear();

    createLanguageModel({ provider: 'openrouter', model: 'anthropic/claude-3.7-sonnet:thinking' });

    expect(openrouterMock).toHaveBeenCalledWith('anthropic/claude-3.7-sonnet:thinking');
  });

  it('passes OpenRouter reasoning exclusion and routing settings', () => {
    openrouterMock.mockClear();

    createLanguageModel({
      provider: 'openrouter',
      model: 'anthropic/claude-3.7-sonnet:thinking',
      openrouter: {
        includeReasoning: false,
        order: ['anthropic', 'openai'],
        allowFallbacks: false,
      },
    });

    expect(openrouterMock).toHaveBeenCalledWith('anthropic/claude-3.7-sonnet:thinking', {
      extraBody: {
        reasoning: {
          exclude: true,
        },
      },
      provider: {
        order: ['anthropic', 'openai'],
        allow_fallbacks: false,
      },
    });
  });

  it('can explicitly request OpenRouter reasoning in responses', () => {
    openrouterMock.mockClear();

    createLanguageModel({
      provider: 'openrouter',
      model: 'anthropic/claude-3.7-sonnet:thinking',
      openrouter: {
        includeReasoning: true,
      },
    });

    expect(openrouterMock).toHaveBeenCalledWith('anthropic/claude-3.7-sonnet:thinking', {
      extraBody: {
        reasoning: {
          exclude: false,
        },
      },
    });
  });

  it('rejects unsupported provider ids clearly', () => {
    expect(() => createLanguageModel({ provider: 'local', model: 'qwen3:0.6b' })).toThrow(
      `Unknown AI SDK provider "local". Built-in: ${supportedProviderIds().join(', ')}`,
    );
  });

  it('rejects providers without embedding support clearly', () => {
    expect(() =>
      createEmbeddingModel({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
    ).toThrow('Provider "anthropic" does not support embeddings through AI SDK');
  });
});

describe('scoring providers', () => {
  it('uses AI SDK embed for configured embeddings providers', async () => {
    embedMock.mockResolvedValueOnce({ embedding: [0.1, 0.2, 0.3] });

    await expect(
      embedText('hello', {
        enabled: true,
        provider: 'openai',
        model: 'text-embedding-3-small',
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual([0.1, 0.2, 0.3]);

    expect(embedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'hello',
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it('uses AI SDK generateText for configured classifier providers', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'related' });

    await expect(
      classifyWithProvider('Classify this.', {
        enabled: true,
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        timeoutMs: 1_000,
      }),
    ).resolves.toBe('related');

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Classify this.',
        temperature: 0,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });
});
