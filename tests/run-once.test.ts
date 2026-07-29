import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/load-config.js';
import type { GenerateModelTextResult } from '../src/llm/generate.js';
import { runOnce } from '../src/run-once.js';

const tempDirs: string[] = [];
// biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
const originalTimeZone = process.env['TZ'];

afterEach(async () => {
  vi.useRealTimers();
  if (originalTimeZone === undefined) {
    // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
    delete process.env['TZ'];
  } else {
    // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
    process.env['TZ'] = originalTimeZone;
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runOnce', () => {
  it('uses a mocked LLM and persists a v1 run when messages match', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-plan-reviews.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '1000', 'U_ALICE', 'Planning auth work today', NULL, 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const result = await runOnce(
      {
        ...resolved,
        config: {
          ...resolved.config,
          model: {
            ...resolved.config.model,
            failOnInvalidOutput: false,
          },
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          context: {
            ...resolved.config.context,
            syntheticThreads: {
              enabled: false,
            },
          },
        },
      },
      async () => modelOutput({ summary: 'Saw Alice planning.' }, 'Alice posted a plan.'),
      {
        dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' },
      },
    );

    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      readonly runs: readonly {
        readonly modelOutputs: readonly {
          readonly usage?: {
            readonly inputTokens?: number;
            readonly outputTokens?: number;
            readonly totalTokens?: number;
          };
        }[];
      }[];
    };

    expect(state.runs[0]?.modelOutputs[0]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });

    expect(result.modelCalled).toBe(true);
    expect(result.matchedMessageCount).toBe(1);
    expect(result.executionMode).toBe('explicit');
    expect(Number(result.scanStartCursor)).toBeLessThan(1000);
    expect(result.scanEndCursor).not.toBeNull();
    expect(result.reportText).toBe('Alice posted a plan.');
  });

  it('repairs model-stripped thread_ts query params in output evidence links', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-plan-reviews.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '1001', 'U_BOB', 'Question', '1001', 'T_TEST');
      INSERT INTO messages VALUES ('m2', 'C_PLANNING', '1002', 'U_ALICE', 'Planning reply today', '1001', 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    let sentPrompt = '';
    const result = await runOnce(
      {
        ...resolved,
        config: {
          ...resolved.config,
          model: {
            ...resolved.config.model,
            failOnInvalidOutput: false,
          },
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          context: {
            ...resolved.config.context,
            syntheticThreads: {
              enabled: false,
            },
          },
        },
      },
      async ({ prompt }) => {
        sentPrompt = prompt;
        return modelOutput(
          { href: 'https://example.slack.com/archives/C_PLANNING/p1002' },
          'Alice replied at https://example.slack.com/archives/C_PLANNING/p1002.',
        );
      },
      {
        dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' },
      },
    );

    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      readonly runs: readonly {
        readonly modelOutputs: readonly {
          readonly outputText: string;
          readonly reportText?: string;
        }[];
        readonly memories: readonly { readonly content: string }[];
      }[];
    };
    const run = state.runs[0];

    const canonicalLink = 'https://example.slack.com/archives/C_PLANNING/p1002?thread_ts=1001';
    expect(sentPrompt).toContain(`"href":"${canonicalLink}"`);
    expect(result.reportText).toBe(`Alice replied at ${canonicalLink}.`);
    expect(run?.modelOutputs[0]?.outputText).toContain(`"href":"${canonicalLink}"`);
    expect(run?.modelOutputs[0]?.reportText).toBe(`Alice replied at ${canonicalLink}.`);
    expect(run?.memories[0]?.content).toContain(`"href":"${canonicalLink}"`);
  });

  it('redacts sensitive text before model calls and state writes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-plan-reviews.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '1000', 'U_ALICE', 'Planning auth work today with Bearer abc.def.ghi and AKIAIOSFODNN7EXAMPLE', NULL, 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    let sentPrompt = '';
    await runOnce(
      {
        ...resolved,
        config: {
          ...resolved.config,
          model: {
            ...resolved.config.model,
            failOnInvalidOutput: false,
          },
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          context: {
            ...resolved.config.context,
            syntheticThreads: {
              enabled: false,
            },
          },
        },
      },
      async ({ prompt }) => {
        sentPrompt = prompt;
        return modelOutput(
          { summary: 'Saw Bearer abc.def.ghi.' },
          'Stored ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ.',
        );
      },
      {
        dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' },
      },
    );

    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      readonly runs: readonly {
        readonly evidenceMessages: readonly { readonly text: string }[];
        readonly modelOutputs: readonly {
          readonly outputText: string;
          readonly reportText?: string;
        }[];
        readonly memories: readonly { readonly content: string }[];
      }[];
    };
    const stateText = JSON.stringify(state);
    const run = state.runs[0];

    expect(sentPrompt).toContain('[REDACTED]');
    expect(sentPrompt).not.toContain('Bearer abc.def.ghi');
    expect(sentPrompt).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(run?.evidenceMessages[0]?.text).toContain('[REDACTED]');
    expect(run?.modelOutputs[0]?.outputText).toContain('[REDACTED]');
    expect(run?.modelOutputs[0]?.reportText).toContain('[REDACTED]');
    expect(run?.memories[0]?.content).toContain('[REDACTED]');
    expect(stateText).not.toContain('Bearer abc.def.ghi');
    expect(stateText).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(stateText).not.toContain('ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ');
  });
  it('stores invalid structured output without report follow-up when reportText is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-plan-reviews.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '1000', 'U_ALICE', 'Planning auth work today', NULL, 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const responses = ['{"memory":{"summary":"Saw Alice planning."}}'];

    await runOnce(
      {
        ...resolved,
        config: {
          ...resolved.config,
          model: {
            ...resolved.config.model,
            failOnInvalidOutput: false,
          },
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          context: {
            ...resolved.config.context,
            syntheticThreads: {
              enabled: false,
            },
          },
        },
      },
      async () => modelText(responses.shift() ?? ''),
      {
        dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' },
      },
    );

    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      readonly runs: readonly {
        readonly modelOutputs: readonly {
          readonly outputText: string;
          readonly reportText?: string;
          readonly schemaValid?: boolean;
          readonly schemaErrors?: unknown;
        }[];
      }[];
    };

    expect(state.runs[0]?.modelOutputs[0]?.outputText).toBe(
      '{"memory":{"summary":"Saw Alice planning."},"reportText":""}',
    );
    expect(state.runs[0]?.modelOutputs[0]?.reportText).toBeUndefined();
    expect(state.runs[0]?.modelOutputs[0]?.schemaValid).toBe(false);
    expect(state.runs[0]?.modelOutputs[0]?.schemaErrors).toBeTruthy();
    expect(responses).toHaveLength(0);
  });

  it('retries schema-invalid model output when failOnInvalidOutput is enabled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-retry-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-test.json');
    const promptPath = path.join(dir, 'prompt.md');
    const configPath = path.join(dir, 'retry-config.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_TEST', '1000', 'U_ALICE', 'Planning auth work today', NULL, 'T_TEST');
    `);
    db.close();

    await writeFile(
      promptPath,
      [
        '# Test Prompt',
        '',
        'Return structured memory and reportText.',
        '',
        '```jsonschema',
        '{"type":"object","required":["status"],"properties":{"status":{"const":"ok"}},"additionalProperties":false}',
        '```',
        '',
      ].join('\n'),
    );
    await writeFile(
      configPath,
      JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          prompts: 'prompt.md',
          model: {
            provider: 'openai',
            model: 'gpt-test',
            minReportWords: 1,
            failOnInvalidOutput: true,
          },
          globalMatchers: [{ id: 'planning', type: 'regex', pattern: 'Planning' }],
          context: {
            syntheticThreads: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
    );

    const resolved = await loadConfig(configPath);
    const prompts: string[] = [];
    const responses = [
      structuredOutputText({ status: 'bad' }, 'Invalid report.'),
      structuredOutputText({ status: 'ok' }, 'Corrected report.'),
    ];

    const result = await runOnce(
      resolved,
      async ({ prompt }) => {
        prompts.push(prompt);
        return modelText(responses.shift() ?? '');
      },
      {
        dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' },
      },
    );

    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      readonly runs: readonly {
        readonly modelOutputs: readonly {
          readonly outputJson?: unknown;
          readonly schemaValid?: boolean | null;
          readonly reportText?: string;
          readonly modelProvider?: string;
          readonly modelName?: string;
          readonly modelAttempts?: number;
          readonly modelCalls?: readonly {
            readonly segmentId?: string;
            readonly provider: string;
            readonly model: string;
            readonly attempts: number;
          }[];
          readonly usage?: {
            readonly inputTokens?: number;
            readonly outputTokens?: number;
            readonly totalTokens?: number;
          };
        }[];
      }[];
    };

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('# OUTPUT VALIDATION RETRY');
    expect(prompts[1]).toContain('must be equal to constant');
    expect(prompts[1]).toContain('longer, more detailed reportText');
    expect(result.reportText).toBe('Corrected report.');
    expect(state.runs[0]?.modelOutputs[0]?.schemaValid).toBe(true);
    expect(state.runs[0]?.modelOutputs[0]?.outputJson).toEqual({ status: 'ok' });
    expect(state.runs[0]?.modelOutputs[0]?.modelProvider).toBe('openai');
    expect(state.runs[0]?.modelOutputs[0]?.modelName).toBe('gpt-test');
    expect(state.runs[0]?.modelOutputs[0]?.modelAttempts).toBe(2);
    expect(state.runs[0]?.modelOutputs[0]?.modelCalls).toEqual([
      {
        segmentId: 'all',
        provider: 'openai',
        model: 'gpt-test',
        attempts: 2,
      },
    ]);
    expect(state.runs[0]?.modelOutputs[0]?.usage).toEqual({
      inputTokens: 20,
      outputTokens: 40,
      totalTokens: 60,
    });
  });

  it('falls back to the next model after configured invalid-output retries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-fallback-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-test.json');
    const promptPath = path.join(dir, 'prompt.md');
    const configPath = path.join(dir, 'fallback-config.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_TEST', '1000', 'U_ALICE', 'Planning auth work today', NULL, 'T_TEST');
    `);
    db.close();

    await writeFile(
      promptPath,
      [
        '# Test Prompt',
        '',
        'Return structured memory and reportText.',
        '',
        '```jsonschema',
        '{"type":"object","required":["status"],"properties":{"status":{"const":"ok"}},"additionalProperties":false}',
        '```',
        '',
      ].join('\n'),
    );
    await writeFile(
      configPath,
      JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          prompts: 'prompt.md',
          model: {
            provider: 'openrouter',
            model: 'primary-model',
            retries: 1,
            minReportWords: 1,
            failOnInvalidOutput: true,
            fallback: {
              provider: 'openai',
              model: 'fallback-model',
              retries: 0,
              minReportWords: 1,
              failOnInvalidOutput: true,
            },
          },
          globalMatchers: [{ id: 'planning', type: 'regex', pattern: 'Planning' }],
          context: {
            syntheticThreads: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
    );

    const resolved = await loadConfig(configPath);
    const calledModels: string[] = [];
    const prompts: string[] = [];
    const responses = [
      structuredOutputText({ status: 'bad' }, 'Invalid report one.'),
      structuredOutputText({ status: 'bad' }, 'Invalid report two.'),
      structuredOutputText({ status: 'ok' }, 'Fallback report.'),
    ];

    const result = await runOnce(
      resolved,
      async ({ config, prompt }) => {
        calledModels.push(config.model.model);
        prompts.push(prompt);
        return modelText(responses.shift() ?? '');
      },
      {
        dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' },
      },
    );

    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      readonly runs: readonly {
        readonly modelOutputs: readonly {
          readonly outputJson?: unknown;
          readonly schemaValid?: boolean | null;
          readonly reportText?: string;
          readonly modelProvider?: string;
          readonly modelName?: string;
          readonly modelAttempts?: number;
          readonly modelCalls?: readonly {
            readonly segmentId?: string;
            readonly provider: string;
            readonly model: string;
            readonly attempts: number;
          }[];
          readonly usage?: {
            readonly inputTokens?: number;
            readonly outputTokens?: number;
            readonly totalTokens?: number;
          };
        }[];
      }[];
    };

    expect(calledModels).toEqual(['primary-model', 'primary-model', 'fallback-model']);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('# OUTPUT VALIDATION RETRY');
    expect(prompts[2]).not.toContain('# OUTPUT VALIDATION RETRY');
    expect(result.reportText).toBe('Fallback report.');
    expect(state.runs[0]?.modelOutputs[0]?.schemaValid).toBe(true);
    expect(state.runs[0]?.modelOutputs[0]?.outputJson).toEqual({ status: 'ok' });
    expect(state.runs[0]?.modelOutputs[0]?.modelProvider).toBe('openai');
    expect(state.runs[0]?.modelOutputs[0]?.modelName).toBe('fallback-model');
    expect(state.runs[0]?.modelOutputs[0]?.modelAttempts).toBe(3);
    expect(state.runs[0]?.modelOutputs[0]?.modelCalls).toEqual([
      {
        segmentId: 'all',
        provider: 'openrouter',
        model: 'primary-model',
        attempts: 2,
      },
      {
        segmentId: 'all',
        provider: 'openai',
        model: 'fallback-model',
        attempts: 1,
      },
    ]);
    expect(state.runs[0]?.modelOutputs[0]?.usage).toEqual({
      inputTokens: 30,
      outputTokens: 60,
      totalTokens: 90,
    });
  });

  it('accepts structured report markdown with a date heading', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-plan-reviews.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '1000', 'U_ALICE', 'Planning auth work today', NULL, 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    let callCount = 0;
    const result = await runOnce(
      {
        ...resolved,
        config: {
          ...resolved.config,
          model: {
            ...resolved.config.model,
            failOnInvalidOutput: false,
          },
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          context: {
            ...resolved.config.context,
            syntheticThreads: {
              enabled: false,
            },
          },
        },
      },
      async () => {
        callCount += 1;
        return modelOutput(
          { summary: 'Saw Alice planning.' },
          '# Date: 2026-06-05\nAlice posted a plan.',
        );
      },
      {
        dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' },
      },
    );

    expect(result.reportText).toBe('# Date: 2026-06-05\nAlice posted a plan.');
    expect(callCount).toBe(1);
  });

  it('filters model timeline by requested local date without advancing implicit cursors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-plan-reviews.json');
    const includedTs = unixSeconds('2026-01-02T12:00:00Z');
    const includedContextTs = unixSeconds('2026-01-02T12:01:00Z');
    const excludedTs = unixSeconds('2026-01-03T12:00:00Z');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '${includedTs}', 'U_ALICE', 'Planning included work today', NULL, 'T_TEST');
      INSERT INTO messages VALUES ('m1-context', 'C_PLANNING', '${includedContextTs}', 'U_BOB', 'Same-day context should stay in budget', NULL, 'T_TEST');
      INSERT INTO messages VALUES ('m2', 'C_PLANNING', '${excludedTs}', 'U_ALICE', 'Planning excluded work tomorrow', NULL, 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    let sentPrompt = '';
    const result = await runOnce(
      {
        ...resolved,
        config: {
          ...resolved.config,
          model: {
            ...resolved.config.model,
            failOnInvalidOutput: false,
          },
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          context: {
            ...resolved.config.context,
            includeRealThread: false,
            nearbyMessagesBeforeMinutes: 0,
            nearbyMessagesAfterMinutes: 60,
            maxMessages: 2,
            syntheticThreads: {
              enabled: false,
            },
          },
        },
      },
      async ({ prompt }) => {
        sentPrompt = prompt;
        return modelOutput({ summary: 'filtered' }, 'Filtered report.');
      },
      {
        dateRange: {
          startDate: '2026-01-02',
          endDate: '2026-01-02',
        },
      },
    );

    expect(result.modelCalled).toBe(true);
    expect(result.matchedMessageCount).toBe(1);
    expect(result.executionMode).toBe('explicit');
    expect(sentPrompt).toContain('Planning included work today');
    expect(sentPrompt).toContain('Same-day context should stay in budget');
    expect(sentPrompt).not.toContain('Planning excluded work tomorrow');
  });

  it('uses an explicit requested range even when a later implicit cursor exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-plan-reviews.json');
    const includedTs = unixSeconds('2026-01-02T12:00:00Z');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '${includedTs}', 'U_ALICE', 'Planning included work today', NULL, 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 'v1',
          topicId: resolved.topicId,
          runs: [
            {
              id: 'future-run',
              topicId: resolved.topicId,
              configHash: resolved.configHash,
              startedAt: '2026-01-03T12:00:00.000Z',
              finishedAt: '2026-01-03T12:00:00.000Z',
              status: 'completed',
              executionMode: 'implicit',
              scanStartCursor: unixSeconds('2026-01-03T00:00:00Z'),
              scanEndCursor: unixSeconds('2026-01-03T12:00:00Z'),
              scanStartedAt: '2026-01-03T12:00:00.000Z',
              scanEndedAt: '2026-01-03T12:00:00.000Z',
              inputMessageCount: 0,
              matchedMessageCount: 0,
              evidenceMessageCount: 0,
              modelCalled: false,
              memories: [],
              modelOutputs: [],
              evidenceMessages: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const result = await runOnce(
      {
        ...resolved,
        config: {
          ...resolved.config,
          model: {
            ...resolved.config.model,
            failOnInvalidOutput: false,
          },
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          context: {
            ...resolved.config.context,
            includeRealThread: false,
            nearbyMessagesBeforeMinutes: 0,
            nearbyMessagesAfterMinutes: 0,
            syntheticThreads: {
              enabled: false,
            },
          },
        },
      },
      async () => modelOutput({ summary: 'filtered' }, 'Filtered report.'),
      {
        dateRange: {
          startDate: '2026-01-02',
          endDate: '2026-01-02',
        },
      },
    );

    expect(result.modelCalled).toBe(true);
    expect(result.executionMode).toBe('explicit');
    expect(result.inputMessageCount).toBe(1);
    expect(result.matchedMessageCount).toBe(1);
    expect(Number(result.scanStartCursor)).toBeLessThan(Number(includedTs));
  });

  it('segments model calls by compiled context size', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-segmented.json');
    const promptPath = path.join(dir, 'prompt.md');
    await writeFile(
      promptPath,
      [
        'Return structured memory and reportText.',
        '',
        '```jsonschema',
        '{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}},"additionalProperties":false}',
        '```',
      ].join('\n'),
      'utf8',
    );
    const firstTs = unixSeconds('2026-01-02T12:00:00Z');
    const secondTs = unixSeconds('2026-01-03T12:00:00Z');
    const longText = 'Planning segmented work '.repeat(80);
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_ONE', '${firstTs}', 'U_ALICE', '${longText} first', NULL, 'T_TEST');
      INSERT INTO messages VALUES ('m2', 'C_TWO', '${secondTs}', 'U_ALICE', '${longText} second', NULL, 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const prompts: string[] = [];
    const result = await runOnce(
      {
        ...resolved,
        topicId: 'segmented',
        config: {
          ...resolved.config,
          prompts: [promptPath],
          model: {
            provider: 'openai',
            model: 'gpt-5.4-mini',
            maxOutputTokens: 1,
            contextWindowTokens: 3800,
          },
          channels: [
            { id: 'C_ONE', name: 'one', kind: 'channel' },
            { id: 'C_TWO', name: 'two', kind: 'channel' },
          ],
          storage: {
            slacrawlDatabasePath: slacrawlPath,
            statePath,
          },
          context: {
            includeRealThread: false,
            nearbyMessagesBeforeMinutes: 0,
            nearbyMessagesAfterMinutes: 0,
            maxMessages: 10,
            syntheticThreads: {
              enabled: false,
            },
          },
        },
      },
      async ({ prompt }) => {
        prompts.push(prompt);
        return modelOutput({ summary: `segment ${prompts.length}` }, `Report ${prompts.length}.`);
      },
      {
        dateRange: { startDate: '2026-01-02', endDate: '2026-01-03' },
      },
    );

    expect(result.modelCalled).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('first');
    expect(prompts[0]).not.toContain('second');
    expect(prompts[1]).toContain('second');
    expect(prompts[1]).toContain('segment 1');
    expect(result.reportText).toContain('Report 1.');
    expect(result.reportText).toContain('Report 2.');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      readonly runs: readonly {
        readonly memories: readonly { readonly content: string }[];
      }[];
    };
    expect(state.runs[0]?.memories[0]?.content).toContain('segment 1');
    expect(state.runs[0]?.memories[0]?.content).toContain('segment 2');
  });

  it('advances implicit cursor on no-match runs without erasing previous memory', async () => {
    // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
    process.env['TZ'] = 'America/Sao_Paulo';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T15:00:00.000Z'));
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-run-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const statePath = path.join(dir, 'state-plan-reviews.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT,
        thread_ts TEXT,
        workspace_id TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '1780660800', 'U_ALICE', 'Planning first work', NULL, 'T_TEST');
      INSERT INTO messages VALUES ('m2', 'C_PLANNING', '1780660900', 'U_BOB', 'Casual first window context', NULL, 'T_TEST');
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const config = {
      ...resolved,
      config: {
        ...resolved.config,
        model: {
          ...resolved.config.model,
          failOnInvalidOutput: false,
        },
        storage: {
          slacrawlDatabasePath: slacrawlPath,
          statePath,
        },
        context: {
          ...resolved.config.context,
          includeRealThread: false,
          nearbyMessagesBeforeMinutes: 0,
          nearbyMessagesAfterMinutes: 0,
          syntheticThreads: {
            enabled: false,
          },
        },
      },
    };

    const first = await runOnce(config, async () =>
      modelOutput({ summary: 'first memory' }, 'First report.'),
    );

    expect(first.modelCalled).toBe(true);
    expect(first.scanStartCursor).toBe('1780628399.999');
    expect(first.scanEndCursor).toBe('1780660900');

    const dbAfterFirst = new DatabaseSync(slacrawlPath);
    dbAfterFirst.exec(`
      INSERT INTO messages VALUES ('m3', 'C_PLANNING', '1780661000', 'U_BOB', 'Casual second window', NULL, 'T_TEST');
    `);
    dbAfterFirst.close();

    const second = await runOnce(config, async () => {
      throw new Error('model should not be called for no-match run');
    });

    expect(second.modelCalled).toBe(false);
    expect(second.matchedMessageCount).toBe(0);
    expect(second.scanStartCursor).toBe('1780660900');
    expect(second.scanEndCursor).toBe('1780661000');

    const dbAfterSecond = new DatabaseSync(slacrawlPath);
    dbAfterSecond.exec(`
      INSERT INTO messages VALUES ('m4', 'C_PLANNING', '1780661100', 'U_ALICE', 'Planning third work', NULL, 'T_TEST');
    `);
    dbAfterSecond.close();

    let thirdPrompt = '';
    const third = await runOnce(config, async ({ prompt }) => {
      thirdPrompt = prompt;
      return modelOutput({ summary: 'third memory' }, 'Third report.');
    });

    expect(third.modelCalled).toBe(true);
    expect(third.scanStartCursor).toBe('1780661000');
    expect(third.scanEndCursor).toBe('1780661100');
    expect(thirdPrompt).toContain('first memory');
  });
});

function unixSeconds(iso: string): string {
  return String(Date.parse(iso) / 1000);
}

function modelOutput(memory: unknown, reportText: string): GenerateModelTextResult {
  const output = { memory, reportText };
  return {
    ...modelText(JSON.stringify(output)),
    output,
  };
}

function structuredOutputText(memory: unknown, reportText: string): string {
  return JSON.stringify({ memory, reportText });
}

function modelText(text: string): GenerateModelTextResult {
  return {
    text,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    },
  };
}
