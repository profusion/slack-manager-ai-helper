import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unifiedReportCommand } from '../src/commands/unified-report.js';
import { loadConfig } from '../src/config/load-config.js';
import type { PersistedState } from '../src/state/state-store.js';
import {
  buildUnifiedReportInput,
  resolveUnifiedReportRange,
  unifiedReport,
} from '../src/unified-report.js';

const tempDirs: string[] = [];
// biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
const originalTimezone = process.env['TZ'];

beforeEach(() => {
  // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
  process.env['TZ'] = 'America/Sao_Paulo';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-06T15:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  if (originalTimezone === undefined) {
    // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
    delete process.env['TZ'];
  } else {
    // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
    process.env['TZ'] = originalTimezone;
  }
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('unifiedReport', () => {
  it('resolves --days as an inclusive local range ending today', () => {
    expect(resolveUnifiedReportRange({ days: 5 }, 'America/Sao_Paulo')).toEqual({
      startDate: '2026-06-02',
      endDate: '2026-06-06',
      days: 5,
    });
  });

  it('rejects --days combined with explicit date flags', () => {
    expect(() =>
      resolveUnifiedReportRange({ days: 5, startDate: '2026-06-01' }, 'America/Sao_Paulo'),
    ).toThrow('--days is mutually exclusive');
  });

  it('resolves named windows for rollups', () => {
    expect(
      resolveUnifiedReportRange({ window: 'previous-5-workdays' }, 'America/Sao_Paulo'),
    ).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-05',
    });
  });

  it('assembles source reports from completed runs by evidence dates and fallback output dates', () => {
    const state = createState();
    const input = buildUnifiedReportInput({
      persistedState: state,
      topicId: 'topic',
      range: {
        startDate: '2026-06-02',
        endDate: '2026-06-05',
      },
      localTimeZone: 'America/Sao_Paulo',
      generatedAt: '2026-06-06T15:00:00.000Z',
    });

    expect(input.sourceOutputs).toEqual([
      {
        date: '2026-06-03',
        runId: 'run-2',
        createdAt: '2026-06-03T16:00:00.000Z',
        reportText: 'Report for day 2.',
      },
      {
        date: '2026-06-04',
        runId: 'run-3',
        createdAt: '2026-06-04T16:00:00.000Z',
        reportText: 'Raw output fallback.',
      },
    ]);
  });

  it('calls the model with selected source reports and does not write state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-unified-report-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    const promptPath = path.join(dir, 'weekly.md');
    const statePath = path.join(dir, 'state-topic.json');
    await writeFile(promptPath, '# Weekly rollup\n');
    await writeFile(statePath, `${JSON.stringify(createState(), null, 2)}\n`);
    const before = await readFile(statePath, 'utf8');
    const resolved = await loadConfig(configPath);
    let sentPrompt = '';

    const result = await unifiedReport(
      resolved,
      {
        promptPath,
        range: {
          startDate: '2026-06-02',
          endDate: '2026-06-05',
        },
      },
      async ({ prompt }) => {
        sentPrompt = prompt;
        return { text: 'Unified weekly report.' };
      },
    );

    expect(result.modelCalled).toBe(true);
    if (!result.modelCalled) {
      throw new Error('Expected unified report to call the model');
    }
    expect(result.reportText).toBe('Unified weekly report.');
    expect(sentPrompt).toContain('Report for day 2.');
    expect(sentPrompt).toContain('Raw output fallback.');
    expect(sentPrompt).not.toContain('Report for day 1.');
    await expect(readFile(statePath, 'utf8')).resolves.toBe(before);
  });

  it('prints a JSON reason and skips the model when no source reports match', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-unified-report-command-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    const statePath = path.join(dir, 'state-topic.json');
    await writeFile(path.join(dir, 'weekly.md'), '# Weekly rollup\n');
    await writeFile(statePath, `${JSON.stringify(createState(), null, 2)}\n`);
    const before = await readFile(statePath, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runUnifiedReportCommand({
      config: configPath,
      prompt: 'weekly.md',
      startDate: '2026-06-06',
      endDate: '2026-06-06',
    });

    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly modelCalled: boolean;
      readonly reason: string;
      readonly state: { readonly sourceOutputs: readonly unknown[] };
    };
    expect(output).toMatchObject({
      modelCalled: false,
      reason: 'no_source_outputs',
    });
    expect(output.state.sourceOutputs).toEqual([]);
    await expect(readFile(statePath, 'utf8')).resolves.toBe(before);
  });
});

async function runUnifiedReportCommand(input: {
  readonly config: string;
  readonly prompt: string;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
}): Promise<void> {
  const handler = unifiedReportCommand.handler;
  if (!handler) {
    throw new Error('unified-report command has no handler');
  }

  await handler({
    ...input,
    _: ['unified-report'],
    $0: 'slack-manager-ai-helper',
  });
}

async function writeTopicConfig(dir: string): Promise<string> {
  const configPath = path.join(dir, 'topic-config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        workspaceUrl: 'https://example.slack.com',
        storage: {
          slacrawlDatabasePath: 'slacrawl.db',
          statePath: 'state-topic.json',
        },
        prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
        channels: [{ id: 'C1' }],
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

function createState(): PersistedState {
  return {
    version: 'v1',
    topicId: 'topic',
    runs: [
      createRun(
        'run-1',
        '2026-06-01T16:00:00.000Z',
        'completed',
        [createModelOutput('output-1', 'run-1', '2026-06-01T16:00:00.000Z', 'Report for day 1.')],
        [createEvidence('run-1', '2026-06-01T12:00:00.000Z')],
      ),
      createRun(
        'run-2',
        '2026-06-03T16:00:00.000Z',
        'completed',
        [createModelOutput('output-2', 'run-2', '2026-06-03T16:00:00.000Z', 'Report for day 2.')],
        [createEvidence('run-2', '2026-06-03T12:00:00.000Z')],
      ),
      createRun(
        'run-3',
        '2026-06-04T16:00:00.000Z',
        'completed',
        [
          {
            id: 'output-3',
            runId: 'run-3',
            topicId: 'topic',
            outputText: 'Raw output fallback.',
            schemaValid: null,
            createdAt: '2026-06-04T16:00:00.000Z',
          },
        ],
        [],
      ),
      createRun(
        'run-4',
        '2026-06-05T16:00:00.000Z',
        'failed',
        [createModelOutput('output-4', 'run-4', '2026-06-05T16:00:00.000Z', 'Failed run report.')],
        [],
      ),
    ],
  };
}

function createRun(
  id: string,
  startedAt: string,
  status: 'completed' | 'failed',
  modelOutputs: PersistedState['runs'][number]['modelOutputs'],
  evidenceMessages: PersistedState['runs'][number]['evidenceMessages'],
) {
  return {
    id,
    topicId: 'topic',
    configHash: `hash-${id}`,
    startedAt,
    finishedAt: startedAt,
    status,
    executionMode: 'explicit' as const,
    scanStartCursor: String(Date.parse(startedAt) / 1000 - 3600),
    scanEndCursor: String(Date.parse(startedAt) / 1000),
    scanStartedAt: startedAt,
    scanEndedAt: startedAt,
    inputMessageCount: 1,
    matchedMessageCount: 1,
    evidenceMessageCount: evidenceMessages.length,
    modelCalled: modelOutputs.length > 0,
    memories: [],
    modelOutputs,
    evidenceMessages,
  };
}

function createModelOutput(id: string, runId: string, createdAt: string, reportText: string) {
  return {
    id,
    runId,
    topicId: 'topic',
    outputText: `### ANALYSIS\n\n${reportText}`,
    reportText,
    schemaValid: null,
    createdAt,
  };
}

function createEvidence(runId: string, timestamp: string) {
  return {
    id: `${runId}:0`,
    runId,
    topicId: 'topic',
    channelId: 'C1',
    ts: String(Date.parse(timestamp) / 1000),
    text: 'Evidence text',
    source: 'match' as const,
  };
}
