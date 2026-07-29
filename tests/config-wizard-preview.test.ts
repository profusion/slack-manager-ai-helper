import { describe, expect, it } from 'vitest';
import { formatMatchPreview } from '../src/config-wizard/preview.js';
import type { PreparedAnalysisRuntime } from '../src/runtime/analysis.js';

describe('config wizard preview', () => {
  it('groups matched anchors by channel and date with compact message lines', () => {
    const preview = formatMatchPreview({
      topicId: 'topic',
      workspaceId: 'workspace',
      inputMessageCount: 5,
      matchedMessageCount: 3,
      evidenceMessageCount: 0,
      executionMode: 'explicit',
      scanStartCursor: null,
      scanEndCursor: '1780749600',
      messages: [],
      matches: [],
      diagnostics: [
        {
          matched: true,
          message: {
            channelId: 'C1',
            ts: '1780662840',
            userId: 'U1',
            text: 'planning update',
          },
          channel: {
            id: 'C1',
            name: 'team-planning',
            users: [{ id: 'U1', name: 'Alice' }],
          },
          matcherId: 'planning',
          matcherType: 'text',
          evaluatedMatcherCount: 1,
        },
        {
          matched: true,
          message: {
            channelId: 'C1',
            ts: '1780749600',
            userId: 'U2',
            text: 'next-day update',
          },
          channel: {
            id: 'C1',
            name: 'team-planning',
            users: [{ id: 'U2', name: 'Bob' }],
          },
          matcherId: 'channel',
          matcherType: 'channel',
          evaluatedMatcherCount: 0,
        },
        {
          matched: true,
          message: {
            channelId: 'C2',
            ts: '1780751400',
            userId: 'U3',
            text: 'delivery update',
          },
          channel: { id: 'C2', name: 'delivery', users: [{ id: 'U3', name: 'Carol' }] },
          matcherId: 'delivery',
          matcherType: 'regex',
          evaluatedMatcherCount: 2,
        },
        {
          matched: false,
          message: {
            channelId: 'C2',
            ts: '1780753200',
            userId: 'U4',
            text: 'not a delivery update',
          },
          channel: { id: 'C2', name: 'delivery', users: [{ id: 'U4', name: 'Dave' }] },
          reason: 'no_positive_match',
          evaluatedMatcherCount: 2,
        },
        {
          matched: false,
          message: {
            channelId: 'C3',
            ts: '1780755000',
            userId: 'U5',
            text: 'outside configured channels',
          },
          reason: 'unconfigured_channel',
          evaluatedMatcherCount: 0,
        },
      ],
      evidence: [],
      previousMemory: null,
      localTimeZone: 'UTC',
      knownUsers: [],
    } satisfies PreparedAnalysisRuntime);

    expect(preview).toContain('Channel C1 (#team-planning)\n2026-06-05');
    expect(preview).toContain('  12:34 MATCH text:planning Alice (U1): planning update');
    expect(preview).toContain(
      '2026-06-06\n  12:40 MATCH channel:channel Bob (U2): next-day update',
    );
    expect(preview).toContain(
      'Channel C2 (#delivery)\n2026-06-06\n  13:10 MATCH regex:delivery Carol (U3): delivery update',
    );
    expect(preview).toContain(`Ignored
Channel C2 (#delivery)
2026-06-06
  13:40 IGNORE no_positive_match Dave (U4): not a delivery update`);
    expect(preview).toContain(`Channel C3
2026-06-06
  14:10 IGNORE unconfigured_channel U5: outside configured channels`);
  });
});
