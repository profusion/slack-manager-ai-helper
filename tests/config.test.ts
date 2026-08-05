import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConfigSemanticsError,
  type ConfigValidationError,
  loadConfig,
  validateRawConfig,
} from '../src/config/load-config.js';

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(
        null,
        JSON.stringify({
          paths: {
            default_database: '~/.slacrawl/slacrawl.db',
          },
        }),
        '',
      );
    },
  ),
);

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const tempDirs: string[] = [];

afterEach(async () => {
  execFileMock.mockClear();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('loadConfig', () => {
  it('loads and validates the plan reviews example', async () => {
    const resolved = await loadConfig('examples/plan-reviews-config.json');

    expect(resolved.topicId).toBe('plan-reviews');
    expect(resolved.config.storage.statePath).toContain('examples/state-plan-reviews.json');
    expect(resolved.config.prompts).toHaveLength(3);
    expect(resolved.configHash).toHaveLength(64);
  });

  it('loads and validates the actions followup example', async () => {
    const resolved = await loadConfig('examples/actions-followup-config.json');

    expect(resolved.topicId).toBe('actions-followup');
    expect(resolved.config.globalMatchers?.some((matcher) => matcher.type === 'and')).toBe(true);
  });

  it('loads and validates the minimal example variants', async () => {
    const planReviews = await loadConfig('examples/plan-reviews-minimal-config.json');
    const actionsFollowup = await loadConfig('examples/actions-followup-minimal-config.json');

    expect(planReviews.config.model.model).toBe('gpt-5.4-mini');
    expect(planReviews.config.storage.slacrawlDatabasePath).toContain('.slacrawl/slacrawl.db');
    expect(actionsFollowup.config.model.model).toBe('gpt-5.4-mini');
    expect(actionsFollowup.config.storage.slacrawlDatabasePath).toContain('.slacrawl/slacrawl.db');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses slacrawl metadata for the default database path when storage is omitted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'default-storage-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai',
            model: 'gpt-test',
          },
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.storage.slacrawlDatabasePath).toContain('.slacrawl/slacrawl.db');
    expect(resolved.config.storage.statePath).toBe(path.join(dir, 'state-default-storage.json'));
    expect(execFileMock).toHaveBeenCalledWith(
      'slacrawl',
      ['metadata', '--json'],
      { encoding: 'utf8' },
      expect.any(Function),
    );
  });

  it('expands alsoChannels into full channel configs with shared users and matchers', () => {
    const config = validateRawConfig(
      {
        workspaceUrl: 'https://example.slack.com',
        prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
        channels: [
          {
            id: 'C_PRIMARY',
            name: 'primary',
            kind: 'channel',
            alsoChannels: [
              { id: 'C_ALSO_A', name: 'also-a' },
              { id: 'C_ALSO_B', kind: 'mpim' },
            ],
            users: [{ id: 'U1', name: 'Alice', role: 'engineer' }],
            matchers: [{ id: 'plan', type: 'regex', pattern: 'plan' }],
          },
        ],
      },
      'also-channels-config',
    );

    expect(config.channels).toEqual([
      {
        id: 'C_PRIMARY',
        name: 'primary',
        kind: 'channel',
        users: [{ id: 'U1', name: 'Alice', role: 'engineer' }],
        matchers: [{ id: 'plan', type: 'regex', pattern: 'plan' }],
      },
      {
        id: 'C_ALSO_A',
        name: 'also-a',
        kind: 'channel',
        users: [{ id: 'U1', name: 'Alice', role: 'engineer' }],
        matchers: [{ id: 'plan', type: 'regex', pattern: 'plan' }],
      },
      {
        id: 'C_ALSO_B',
        kind: 'mpim',
        users: [{ id: 'U1', name: 'Alice', role: 'engineer' }],
        matchers: [{ id: 'plan', type: 'regex', pattern: 'plan' }],
      },
    ]);
  });

  it('rejects alsoChannels that collide with another expanded channel id', () => {
    expect(() =>
      validateRawConfig(
        {
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai',
            model: 'gpt-test',
          },
          channels: [
            {
              id: 'C_PRIMARY',
              alsoChannels: [{ id: 'C_SHARED' }],
            },
            {
              id: 'C_OTHER',
              alsoChannels: [{ id: 'C_SHARED' }],
            },
          ],
        },
        'duplicate-also-channels-config',
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'ConfigSemanticsError',
        message: expect.stringContaining('duplicate channel id C_SHARED'),
      }) as ConfigSemanticsError,
    );
  });

  it('rejects removed checkpoint settings', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'removed-checkpoint-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          checkpoint: {
            startFrom: 'beginning',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai',
            model: 'gpt-test',
          },
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  it('uses empty context settings when context is omitted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'default-context-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai',
            model: 'gpt-test',
          },
          channels: [{ id: 'C' }],
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.context).toEqual({});
  });

  it('accepts a custom base URL for analysis model providers', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'custom-model-endpoint-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai-compatible',
            model: 'local-model',
            baseUrl: 'http://127.0.0.1:8080/v1',
          },
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.model.baseUrl).toBe('http://127.0.0.1:8080/v1');
  });

  it('accepts reasoning effort for analysis model providers', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'reasoning-effort-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai-compatible',
            model: 'gpt-5.4-mini',
            reasoningEffort: 'high',
          },
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.model.reasoningEffort).toBe('high');
  });

  it('accepts recursive analysis model fallbacks and defaults retries per model', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'fallback-model-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openrouter',
            model: 'z-ai/glm-5.2',
            retries: 1,
            fallback: {
              provider: 'openai',
              model: 'gpt-5.4',
              fallback: {
                provider: 'anthropic',
                model: 'claude-test',
              },
            },
          },
          channels: [{ id: 'C' }],
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.model.retries).toBe(1);
    expect(resolved.config.model.minReportWords).toBe(25);
    expect(resolved.config.model.fallback?.provider).toBe('openai');
    expect(resolved.config.model.fallback?.retries).toBe(3);
    expect(resolved.config.model.fallback?.minReportWords).toBe(25);
    expect(resolved.config.model.fallback?.fallback?.provider).toBe('anthropic');
    expect(resolved.config.model.fallback?.fallback?.retries).toBe(3);
  });

  it('accepts OpenRouter reasoning and routing settings', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'openrouter-settings-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openrouter',
            model: 'anthropic/claude-3.7-sonnet:thinking',
            openrouter: {
              includeReasoning: false,
              order: ['anthropic', 'openai'],
              allowFallbacks: false,
            },
          },
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.model.openrouter).toEqual({
      includeReasoning: false,
      order: ['anthropic', 'openai'],
      allowFallbacks: false,
    });
  });

  it('rejects invalid reasoning effort values', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'invalid-reasoning-effort-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai-compatible',
            model: 'gpt-5.4-mini',
            reasoningEffort: 'extreme',
          },
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    await expect(loadConfig(configPath)).rejects.toMatchObject({
      name: 'ConfigValidationError',
    });
  });
  it('allows channels to be omitted when global matchers are configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'global-matchers-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai',
            model: 'gpt-test',
          },
          globalMatchers: [{ id: 'manager_mentions', type: 'mention', userId: 'U_MANAGER' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.channels).toEqual([]);
    expect(resolved.config.globalMatchers).toHaveLength(1);
  });

  it('accepts top-level exclude matchers wrapping positive expressions', async () => {
    const resolved = await loadConfig(
      await writeTempConfig('exclude-matchers-config.json', {
        storage: {
          slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
        },
        prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
        globalMatchers: [
          {
            id: 'ignore_regex',
            type: 'exclude',
            matcher: { id: 'internal_regex', type: 'regex', pattern: '\\bignore\\b' },
          },
          {
            id: 'ignore_and',
            type: 'exclude',
            matcher: {
              id: 'internal_and',
              type: 'and',
              matchers: [
                { id: 'manager', type: 'mention', userId: 'U_MANAGER' },
                { id: 'planning', type: 'text', terms: ['planning'] },
              ],
            },
          },
          {
            id: 'ignore_or',
            type: 'exclude',
            matcher: {
              id: 'internal_or',
              type: 'or',
              matchers: [
                { id: 'archived', type: 'text', terms: ['archived'] },
                { id: 'cancelled', type: 'text', terms: ['cancelled'] },
              ],
            },
          },
          { id: 'planning', type: 'text', terms: ['planning'] },
        ],
      }),
    );

    expect(resolved.config.globalMatchers).toHaveLength(4);
  });

  it('rejects exclude matchers nested inside AND matchers', async () => {
    const configPath = await writeTempConfig('nested-exclude-and-config.json', {
      prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
      model: {
        provider: 'openai',
        model: 'gpt-test',
      },
      globalMatchers: [
        {
          id: 'invalid_and',
          type: 'and',
          matchers: [
            {
              id: 'nested_exclude',
              type: 'exclude',
              matcher: { id: 'internal', type: 'text', terms: ['ignore'] },
            },
          ],
        },
      ],
    });

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  it('rejects exclude matchers nested inside OR matchers', async () => {
    const configPath = await writeTempConfig('nested-exclude-or-config.json', {
      prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
      model: {
        provider: 'openai',
        model: 'gpt-test',
      },
      globalMatchers: [
        {
          id: 'invalid_or',
          type: 'or',
          matchers: [
            {
              id: 'nested_exclude',
              type: 'exclude',
              matcher: { id: 'internal', type: 'text', terms: ['ignore'] },
            },
          ],
        },
      ],
    });

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  it('rejects exclude matchers wrapping another exclude matcher', async () => {
    const configPath = await writeTempConfig('nested-exclude-config.json', {
      prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
      model: {
        provider: 'openai',
        model: 'gpt-test',
      },
      globalMatchers: [
        {
          id: 'outer_exclude',
          type: 'exclude',
          matcher: {
            id: 'inner_exclude',
            type: 'exclude',
            matcher: { id: 'internal', type: 'text', terms: ['ignore'] },
          },
        },
      ],
    });

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  it('rejects old regex caseInsensitive config', async () => {
    const configPath = await writeTempConfig('regex-case-insensitive-config.json', {
      prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
      model: {
        provider: 'openai',
        model: 'gpt-test',
      },
      globalMatchers: [
        {
          id: 'old_regex',
          type: 'regex',
          pattern: '\\bplanning\\b',
          caseInsensitive: true,
        },
      ],
    });

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  it('normalizes a single prompt filename into the resolved prompt array', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'single-prompt-config.json');
    const promptPath = path.join(dir, 'PROMPT.md');
    await writeFile(promptPath, 'Prompt text.\n');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: 'PROMPT.md',
          model: {
            provider: 'openai',
            model: 'gpt-test',
          },
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.prompts).toHaveLength(1);
    expect(resolved.config.prompts[0]).toBe(promptPath);
  });

  it('keeps built-in prompt tokens as prompt references', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'built-in-prompts-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai',
            model: 'gpt-test',
          },
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    const resolved = await loadConfig(configPath);

    expect(resolved.config.prompts).toEqual(['@DEFAULT_BASE_INSTRUCTIONS@']);
  });

  it('rejects an empty synthetic-thread classifier range list', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'invalid-classifier-ranges-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          storage: {
            slacrawlDatabasePath: '~/.slacrawl/slacrawl.db',
          },
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: {
            provider: 'openai',
            model: 'gpt-test',
          },
          channels: [{ id: 'C' }],
          context: {
            syntheticThreads: {
              classifier: {
                enabled: true,
                useForRanges: [],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  it('exposes structured validation errors for invalid configs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'invalid-structured-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          channels: [{ id: 'C' }],
          context: {},
        },
        null,
        2,
      )}\n`,
    );

    await expect(loadConfig(configPath)).rejects.toMatchObject({
      name: 'ConfigValidationError',
      configPath,
      validationErrors: expect.any(Array),
    } satisfies Partial<ConfigValidationError>);
  });
});

async function writeTempConfig(filename: string, config: object): Promise<string> {
  const configWithWorkspace = { workspaceUrl: 'https://example.slack.com', ...config };
  const dir = await mkdtemp(path.join(tmpdir(), 'smah-config-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, filename);
  await writeFile(configPath, `${JSON.stringify(configWithWorkspace, null, 2)}\n`);
  return configPath;
}
