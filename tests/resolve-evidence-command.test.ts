import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { resolveEvidenceCommand } from '../src/commands/resolve-evidence.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('resolve-evidence command', () => {
  it('prints a Slack HTTP permalink by default', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-resolve-evidence-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    await writeState(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runResolveEvidenceCommand({
      config: configPath,
      id: 'run-1:0',
      output: 'link',
    });

    expect(log.mock.calls[0]?.[0]).toBe(
      'https://example.slack.com/archives/C1/p1000123456?thread_ts=999.000001',
    );
  });

  it('prints JSON when requested', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-resolve-evidence-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    await writeState(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runResolveEvidenceCommand({
      config: configPath,
      id: 'run-1:0',
      output: 'json',
    });

    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly resolvedBy: string;
      readonly evidenceId: string;
      readonly channelName: string;
      readonly text: string;
      readonly slackHttpLink: string;
      readonly slackReference: string;
    };
    expect(output).toMatchObject({
      resolvedBy: 'evidenceId',
      evidenceId: 'run-1:0',
      channelName: 'team-planning',
      text: 'planning [REDACTED]',
      slackHttpLink: 'https://example.slack.com/archives/C1/p1000123456?thread_ts=999.000001',
    });
    expect(output.slackReference).toContain('slack-reference channel=C1');
  });

  it('resolves a unique Slack message id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-resolve-evidence-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    await writeState(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runResolveEvidenceCommand({
      config: configPath,
      id: 'e1a4dcb8-aa76-4e2a-8594-00f331ab3c69',
      output: 'json',
    });

    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly resolvedBy: string;
      readonly evidenceId: string;
      readonly messageId: string;
    };
    expect(output).toMatchObject({
      resolvedBy: 'messageId',
      evidenceId: 'run-1:0',
      messageId: 'e1a4dcb8-aa76-4e2a-8594-00f331ab3c69',
    });
  });

  it('falls back to a config-adjacent default state file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-resolve-evidence-'));
    tempDirs.push(dir);
    const tmpConfigDir = path.join(dir, 'tmp');
    const configPath = await writeTopicConfig(tmpConfigDir, { omitStatePath: true });
    await writeState(tmpConfigDir, { topicId: 'topic' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runResolveEvidenceCommand({
      config: configPath,
      id: 'e1a4dcb8-aa76-4e2a-8594-00f331ab3c69',
      output: 'json',
    });

    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly resolvedBy: string;
      readonly statePath: string;
    };
    expect(output).toMatchObject({
      resolvedBy: 'messageId',
      statePath: path.join(tmpConfigDir, 'state-topic.json'),
    });
  });

  it('fails clearly when a message id matches multiple evidence records', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-resolve-evidence-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    await writeState(dir, { duplicateMessageId: true });

    await expect(
      runResolveEvidenceCommand({
        config: configPath,
        id: 'e1a4dcb8-aa76-4e2a-8594-00f331ab3c69',
        output: 'link',
      }),
    ).rejects.toThrow(
      'Evidence message id is ambiguous: e1a4dcb8-aa76-4e2a-8594-00f331ab3c69 matched 2 evidence records',
    );
  });

  it('fails clearly when the evidence id does not exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-resolve-evidence-'));
    tempDirs.push(dir);
    const configPath = await writeTopicConfig(dir);
    await writeState(dir);

    await expect(
      runResolveEvidenceCommand({
        config: configPath,
        id: 'missing',
        output: 'link',
      }),
    ).rejects.toThrow('Evidence id or message id not found: missing');
  });

  it('rejects invalid output formats', async () => {
    await expect(
      async () =>
        await yargs([
          'resolve-evidence',
          '--config',
          'topic-config.json',
          '--id',
          'run-1:0',
          '--output',
          'xml',
        ])
          .scriptName('slack-manager-ai-helper')
          .command(resolveEvidenceCommand)
          .demandCommand(1)
          .strict()
          .exitProcess(false)
          .fail((message, error) => {
            throw error ?? new Error(message);
          })
          .parseAsync(),
    ).rejects.toThrow('Invalid values');
  });
});

async function runResolveEvidenceCommand(input: {
  readonly config: string;
  readonly id: string;
  readonly output: 'link' | 'json';
}): Promise<void> {
  const handler = resolveEvidenceCommand.handler;
  if (!handler) {
    throw new Error('resolve-evidence command has no handler');
  }

  await handler({
    ...input,
    _: ['resolve-evidence'],
    $0: 'slack-manager-ai-helper',
  });
}

async function writeTopicConfig(
  dir: string,
  options: { readonly omitStatePath?: boolean } = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const configPath = path.join(dir, 'topic-config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        workspaceUrl: 'https://example.slack.com',
        storage: {
          slacrawlDatabasePath: 'slacrawl.db',
          ...(options.omitStatePath ? {} : { statePath: 'state-topic.json' }),
        },
        prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
        channels: [
          {
            id: 'C1',
            name: 'team-planning',
            kind: 'channel',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

async function writeState(
  dir: string,
  options: { readonly duplicateMessageId?: boolean; readonly topicId?: string } = {},
): Promise<void> {
  const topicId = options.topicId ?? 'topic';
  await writeFile(
    path.join(dir, `state-${topicId}.json`),
    `${JSON.stringify(
      {
        version: 'v1',
        topicId,
        runs: [
          {
            id: 'run-1',
            topicId,
            configHash: 'hash',
            startedAt: '2026-06-01T00:00:00.000Z',
            finishedAt: '2026-06-01T00:01:00.000Z',
            status: 'completed',
            executionMode: 'explicit',
            scanStartCursor: '999',
            scanEndCursor: '1002',
            scanStartedAt: '2026-06-01T00:00:00.000Z',
            scanEndedAt: '2026-06-01T00:01:00.000Z',
            inputMessageCount: 1,
            matchedMessageCount: 1,
            evidenceMessageCount: options.duplicateMessageId ? 2 : 1,
            modelCalled: true,
            memories: [],
            modelOutputs: [],
            evidenceMessages: [
              {
                id: 'run-1:0',
                runId: 'run-1',
                topicId,
                channelId: 'C1',
                messageId: 'e1a4dcb8-aa76-4e2a-8594-00f331ab3c69',
                ts: '1000.123456',
                threadTs: '999.000001',
                userId: 'U1',
                text: 'planning [REDACTED]',
                source: 'match',
              },
              ...(options.duplicateMessageId
                ? [
                    {
                      id: 'run-1:1',
                      runId: 'run-1',
                      topicId,
                      channelId: 'C1',
                      messageId: 'e1a4dcb8-aa76-4e2a-8594-00f331ab3c69',
                      ts: '1001.123456',
                      userId: 'U2',
                      text: 'duplicate message id',
                      source: 'nearby',
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}
