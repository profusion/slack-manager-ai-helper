import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifySyntheticScore,
  findSyntheticRelatedMessagesWithProviders,
  isTopLevelSlackMessage,
  scoreCandidate,
} from '../src/synthetic/synthetic-thread.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('synthetic thread scoring', () => {
  it('classifies thresholds', () => {
    expect(classifySyntheticScore(0.5, undefined)).toBe('unrelated');
    expect(classifySyntheticScore(0.65, undefined)).toBe('ambiguous');
    expect(classifySyntheticScore(0.8, undefined)).toBe('related');
  });

  it('scores related-looking messages', () => {
    const score = scoreCandidate(
      {
        channelId: 'C',
        ts: '1000',
        userId: 'U1',
        text: 'Planning review for auth migration is blocked',
      },
      {
        channelId: 'C',
        ts: '1100',
        userId: 'U1',
        text: 'I checked the auth migration planning blocker and it is done',
      },
      {
        enabled: true,
        heuristics: {
          keywords: ['planning', 'blocked', 'done'],
          messageHasReplyMarkers: ['I checked'],
        },
      },
    );

    expect(score).toBeGreaterThan(0.4);
  });

  it('uses a one-hour default synthetic candidate window', () => {
    const scoreInsideDefaultWindow = scoreCandidate(
      {
        channelId: 'C',
        ts: '1000',
        text: 'planning',
      },
      {
        channelId: 'C',
        ts: '2800',
        text: 'planning done',
      },
      {
        enabled: true,
      },
    );
    const scoreOutsideDefaultWindow = scoreCandidate(
      {
        channelId: 'C',
        ts: '1000',
        text: 'planning',
      },
      {
        channelId: 'C',
        ts: '4601',
        text: 'planning done',
      },
      {
        enabled: true,
      },
    );

    expect(scoreInsideDefaultWindow).toBeGreaterThan(scoreOutsideDefaultWindow);
  });

  it('enables synthetic-thread detection when enabled is omitted', async () => {
    const relations = await findSyntheticRelatedMessagesWithProviders(
      {
        channelId: 'C',
        ts: '1000',
        userId: 'U1',
        text: 'planning handoff blocker',
      },
      [
        {
          channelId: 'C',
          ts: '1010',
          userId: 'U1',
          text: 'planning handoff blocker resolved',
        },
      ],
      {},
      undefined,
    );

    expect(relations).toHaveLength(1);
    expect(relations[0]?.method).toBe('heuristic');
  });

  it('allows explicitly disabling synthetic-thread detection', async () => {
    const relations = await findSyntheticRelatedMessagesWithProviders(
      {
        channelId: 'C',
        ts: '1000',
        userId: 'U1',
        text: 'planning handoff blocker',
      },
      [
        {
          channelId: 'C',
          ts: '1010',
          userId: 'U1',
          text: 'planning handoff blocker resolved',
        },
      ],
      {
        enabled: false,
      },
      undefined,
    );

    expect(relations).toEqual([]);
  });

  it('only treats top-level Slack messages as synthetic thread anchors or candidates', () => {
    expect(isTopLevelSlackMessage({ channelId: 'C', ts: '1000', text: 'top' })).toBe(true);
    expect(
      isTopLevelSlackMessage({
        channelId: 'C',
        ts: '1000',
        threadTs: '1000',
        text: 'thread root',
      }),
    ).toBe(true);
    expect(
      isTopLevelSlackMessage({
        channelId: 'C',
        ts: '1001',
        threadTs: '1000',
        text: 'thread reply',
      }),
    ).toBe(false);
  });

  it('does not score synthetic threads for reply anchors', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const relations = await findSyntheticRelatedMessagesWithProviders(
      {
        channelId: 'C',
        ts: '1001',
        threadTs: '1000',
        text: 'thread reply anchor',
      },
      [{ channelId: 'C', ts: '1002', text: 'top level candidate' }],
      {
        enabled: true,
        embeddings: {
          enabled: true,
        },
      },
      undefined,
    );

    expect(relations).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not score reply candidates as synthetic threads', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const relations = await findSyntheticRelatedMessagesWithProviders(
      {
        channelId: 'C',
        ts: '1000',
        threadTs: '1000',
        text: 'top level anchor',
      },
      [{ channelId: 'C', ts: '1001', threadTs: '1000', text: 'thread reply candidate' }],
      {
        enabled: true,
        embeddings: {
          enabled: true,
        },
      },
      undefined,
    );

    expect(relations).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses provider execution for synthetic-thread embeddings and classifier', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ollamaEmbedResponse([[1, 0]])))
      .mockResolvedValueOnce(jsonResponse(ollamaEmbedResponse([[1, 0]])))
      .mockResolvedValueOnce(jsonResponse(ollamaGenerateResponse('related')));
    vi.stubGlobal('fetch', fetchMock);

    const relations = await findSyntheticRelatedMessagesWithProviders(
      {
        channelId: 'C',
        ts: '1000',
        userId: 'U1',
        text: 'Can you follow up on this action?',
      },
      [
        {
          channelId: 'C',
          ts: '1001',
          userId: 'U2',
          text: 'I checked the follow up and it is blocked',
        },
      ],
      {
        enabled: true,
        thresholds: {
          ambiguousFrom: 0.4,
          ambiguousBelow: 0.99,
          relatedFrom: 0.99,
        },
        scoring: {
          semanticSimilarityWeight: 0.5,
        },
        embeddings: {
          enabled: true,
          provider: 'ollama',
        },
        classifier: {
          enabled: true,
          provider: 'ollama',
          useForRanges: ['ambiguous'],
        },
      },
      undefined,
    );

    expect(relations).toHaveLength(1);
    expect(relations[0]?.method).toBe('classifier');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function ollamaEmbedResponse(embeddings: number[][]): unknown {
  return {
    model: 'nomic-embed-text',
    embeddings,
    total_duration: 1,
    load_duration: 1,
    prompt_eval_count: 1,
  };
}

function ollamaGenerateResponse(response: string): unknown {
  return {
    model: 'qwen3:0.6b',
    created_at: '2026-06-05T00:00:00Z',
    response,
    done: true,
    context: [],
    total_duration: 1,
    load_duration: 1,
    prompt_eval_count: 1,
    eval_count: 1,
  };
}
