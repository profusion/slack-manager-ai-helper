import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactStateCommand } from '../src/commands/compact-state.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('compact-state command', () => {
  it('compacts state, creates a backup, and prints a JSON summary', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-compact-command-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    const statePath = path.join(dir, 'state-topic.json');
    await writeFile(statePath, `${JSON.stringify(createCommandState(), null, 2)}\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCompactCommand({
      config: configPath,
      'keep-runs': 1,
      backup: true,
    });

    const summary = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly topicId: string;
      readonly statePath: string;
      readonly backupPath: string | null;
      readonly after: { readonly runs: number };
      readonly removed: { readonly runs: number; readonly modelOutputs: number };
      readonly retainedRunIds: readonly string[];
    };
    expect(summary).toMatchObject({
      topicId: 'topic',
      statePath,
      after: { runs: 2 },
      removed: { runs: 0, modelOutputs: 1 },
      retainedRunIds: ['run-2'],
    });
    expect(summary.backupPath).toContain('state-topic.json.');
    expect(summary.backupPath).toContain('.bak');
    await expect(access(String(summary.backupPath))).resolves.toBeUndefined();

    const compacted = JSON.parse(await readFile(statePath, 'utf8')) as ReturnType<
      typeof createCommandState
    >;
    expect(compacted.runs.map((run) => run.id)).toEqual(['run-1', 'run-2']);
    expect(compacted.runs.flatMap((run) => run.modelOutputs.map((output) => output.runId))).toEqual(
      ['run-2'],
    );
  });

  it('skips backup creation when requested', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-compact-command-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    await writeFile(
      path.join(dir, 'state-topic.json'),
      `${JSON.stringify(createCommandState(), null, 2)}\n`,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCompactCommand({
      config: configPath,
      'keep-runs': 1,
      backup: false,
    });

    const summary = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly backupPath: string | null;
    };
    const files = await readdir(dir);
    expect(summary.backupPath).toBeNull();
    expect(files.some((file) => file.endsWith('.bak'))).toBe(false);
  });
});

async function runCompactCommand(input: {
  readonly config: string;
  readonly 'keep-runs': number;
  readonly backup: boolean;
}): Promise<void> {
  const handler = compactStateCommand.handler;
  if (!handler) {
    throw new Error('compact-state command has no handler');
  }

  await handler({
    ...input,
    keepRuns: input['keep-runs'],
    _: ['compact-state'],
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

function createCommandState() {
  return {
    version: 'v1',
    topicId: 'topic',
    runs: ['run-1', 'run-2'].map((id, index) => ({
      id,
      topicId: 'topic',
      configHash: `hash-${index}`,
      startedAt: `2026-06-0${index + 1}T00:00:00.000Z`,
      finishedAt: `2026-06-0${index + 1}T00:01:00.000Z`,
      status: 'completed',
      executionMode: 'implicit',
      scanStartCursor: index === 0 ? null : '1000',
      scanEndCursor: String((index + 1) * 1000),
      scanStartedAt: `2026-06-0${index + 1}T00:00:00.000Z`,
      scanEndedAt: `2026-06-0${index + 1}T00:01:00.000Z`,
      inputMessageCount: 1,
      matchedMessageCount: 1,
      evidenceMessageCount: 1,
      modelCalled: true,
      memories:
        id === 'run-1'
          ? [
              {
                id: 'memory-1',
                topicId: 'topic',
                scope: 'global',
                scopeId: null,
                content: 'memory',
                contentType: 'text',
                createdAt: '2026-06-01T00:00:00.000Z',
                runId: 'run-1',
              },
            ]
          : [],
      modelOutputs: [
        {
          id: `output-${index + 1}`,
          runId: id,
          topicId: 'topic',
          outputText: `output ${index + 1}`,
          schemaValid: null,
          createdAt: `2026-06-0${index + 1}T00:02:00.000Z`,
        },
      ],
      evidenceMessages: [
        {
          id: `${id}:0`,
          runId: id,
          topicId: 'topic',
          channelId: 'C1',
          ts: String(index + 1),
          text: `evidence ${index + 1}`,
          source: 'match',
        },
      ],
    })),
  } as const;
}
