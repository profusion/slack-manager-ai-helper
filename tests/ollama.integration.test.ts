import { describe, expect, it } from 'vitest';
import { matchesWithProviders } from '../src/matching/matchers.js';
import type { AppConfig, MatcherConfig, SlackMessage } from '../src/types.js';

const runOllamaTests = readEnv('RUN_OLLAMA_TESTS') === '1';
const describeIfOllama = runOllamaTests ? describe.sequential : describe.skip;
const ollamaTestTimeoutMs = Number(readEnv('OLLAMA_TEST_TIMEOUT_MS') ?? 180_000);
const ollamaProviderTimeoutMs = Number(readEnv('OLLAMA_PROVIDER_TIMEOUT_MS') ?? 120_000);

const positiveMessage: SlackMessage = {
  channelId: 'C1',
  ts: '1000',
  userId: 'U1',
  text: 'Follow up on the blocked checkout rollout today.',
};

const negativeMessage: SlackMessage = {
  channelId: 'C1',
  ts: '1001',
  userId: 'U1',
  text: 'The cafeteria menu changed for tomorrow.',
};

describeIfOllama('AI SDK Ollama scored matcher integration', () => {
  it(
    'matches with embeddings only',
    async () => {
      const matcher = semanticMatcher();
      const config = sampleConfig({
        embeddingsEnabled: true,
        classifierEnabled: false,
      });

      await expect(matchesWithProviders(positiveMessage, matcher, config)).resolves.toBe(true);
      await expect(matchesWithProviders(negativeMessage, matcher, config)).resolves.toBe(false);
    },
    ollamaTestTimeoutMs,
  );

  it(
    'matches with classifier only',
    async () => {
      const matcher = classifierMatcher();
      const config = sampleConfig({
        embeddingsEnabled: false,
        classifierEnabled: true,
      });

      await expect(matchesWithProviders(positiveMessage, matcher, config)).resolves.toBe(true);
      await expect(matchesWithProviders(negativeMessage, matcher, config)).resolves.toBe(false);
    },
    ollamaTestTimeoutMs,
  );

  it(
    'matches with embeddings and classifier together',
    async () => {
      const matcher = combinedMatcher();
      const config = sampleConfig({
        embeddingsEnabled: true,
        classifierEnabled: true,
      });

      await expect(matchesWithProviders(positiveMessage, matcher, config)).resolves.toBe(true);
      await expect(matchesWithProviders(negativeMessage, matcher, config)).resolves.toBe(false);
    },
    ollamaTestTimeoutMs,
  );
});

function semanticMatcher(): Extract<MatcherConfig, { readonly type: 'scored' }> {
  return {
    id: 'ollama_embeddings_action',
    type: 'scored',
    question: positiveMessage.text,
    thresholds: {
      relatedFrom: 0.85,
    },
    scoring: {
      semanticSimilarityWeight: 1,
      questionSimilarityWeight: 0,
      keywordWeight: 0,
      phraseWeight: 0,
      patternWeight: 0,
    },
  };
}

function classifierMatcher(): Extract<MatcherConfig, { readonly type: 'scored' }> {
  return {
    id: 'ollama_classifier_action',
    type: 'scored',
    question: 'Is this Slack message asking someone to track a concrete action or blocker?',
    scoring: {
      semanticSimilarityWeight: 0,
      questionSimilarityWeight: 0,
      keywordWeight: 0,
      phraseWeight: 0,
      patternWeight: 0,
    },
  };
}

function combinedMatcher(): Extract<MatcherConfig, { readonly type: 'scored' }> {
  return {
    ...classifierMatcher(),
    id: 'ollama_embeddings_classifier_action',
    thresholds: {
      ambiguousFrom: 0.2,
      ambiguousBelow: 0.99,
      relatedFrom: 0.99,
    },
    scoring: {
      semanticSimilarityWeight: 0.2,
      keywordWeight: 0.2,
      phraseWeight: 0.2,
    },
  };
}

function sampleConfig(input: {
  readonly embeddingsEnabled: boolean;
  readonly classifierEnabled: boolean;
}): Pick<AppConfig, 'scoredMatcherDefaults'> {
  return {
    scoredMatcherDefaults: {
      embeddings: {
        enabled: input.embeddingsEnabled,
        provider: 'ollama',
        model: readEnv('OLLAMA_EMBEDDINGS_MODEL') ?? 'nomic-embed-text',
        baseUrl: readEnv('OLLAMA_URL') ?? 'http://127.0.0.1:11434',
        timeoutMs: ollamaProviderTimeoutMs,
      },
      classifier: {
        enabled: input.classifierEnabled,
        provider: 'ollama',
        model: readEnv('OLLAMA_CLASSIFIER_MODEL') ?? 'qwen3:0.6b',
        baseUrl: readEnv('OLLAMA_URL') ?? 'http://127.0.0.1:11434',
        timeoutMs: ollamaProviderTimeoutMs,
        useForRanges: ['unrelated', 'ambiguous', 'related'],
      },
    },
  };
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}
