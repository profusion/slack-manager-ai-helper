import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateModelText, modelSupportsTemperature } from '../src/llm/generate.js';

const { generateTextMock, wrapLanguageModelMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  wrapLanguageModelMock: vi.fn(({ model }) => ({ wrapped: model })),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: generateTextMock,
    wrapLanguageModel: wrapLanguageModelMock,
  };
});

describe('analysis model options', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    wrapLanguageModelMock.mockClear();
  });

  it('omits temperature for OpenAI reasoning model families', () => {
    expect(
      modelSupportsTemperature({
        provider: 'openai-compatible',
        model: 'gpt-5.4-mini',
      }),
    ).toBe(false);
    expect(
      modelSupportsTemperature({
        provider: 'openai',
        model: 'o4-mini',
      }),
    ).toBe(false);
  });

  it('keeps temperature for non-reasoning model families', () => {
    expect(
      modelSupportsTemperature({
        provider: 'openai',
        model: 'gpt-4.1-mini',
      }),
    ).toBe(true);
    expect(
      modelSupportsTemperature({
        provider: 'anthropic',
        model: 'claude-test',
      }),
    ).toBe(true);
  });

  it('passes reasoning effort through provider options', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'ok' });

    await generateModelText({
      config: {
        workspaceUrl: 'https://example.slack.com',
        prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
        model: {
          provider: 'openai-compatible',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'high',
        },
      },
      system: 'system',
      prompt: 'prompt',
    });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          openaiCompatible: {
            reasoningEffort: 'high',
          },
        },
      }),
    );
  });

  it('requests structured output when an output schema is provided', async () => {
    const output = {
      memory: { status: 'ok' },
      reportText: 'Report.',
    };
    generateTextMock.mockResolvedValueOnce({ text: JSON.stringify(output), output });

    const result = await generateModelText({
      config: {
        workspaceUrl: 'https://example.slack.com',
        prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
        model: {
          provider: 'openai',
          model: 'gpt-4.1-mini',
        },
      },
      system: 'system',
      prompt: 'prompt',
      outputSchema: {
        type: 'object',
        required: ['memory', 'reportText'],
        properties: {
          memory: { type: 'object' },
          reportText: { type: 'string' },
        },
      },
    });

    expect(result.output).toEqual(output);
    expect(wrapLanguageModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: expect.objectContaining({}),
      }),
    );
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          wrapped: expect.anything(),
        }),
        output: expect.objectContaining({
          name: 'object',
        }),
      }),
    );
  });
});
