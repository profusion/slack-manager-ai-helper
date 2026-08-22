import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managePortfolioCommand } from '../src/commands/manage-portfolio.js';
import {
  applyMemberMove,
  type PortfolioPromptApi,
  runManagePortfolioWizard,
} from '../src/portfolio/manage-portfolio.js';

const tempDirs: string[] = [];
const initCwdEnvKey = 'INIT_CWD';

type SavedPortfolio = {
  readonly analyses: readonly {
    readonly targets: readonly {
      readonly analysisConfig: {
        readonly context?: unknown;
        readonly channels: readonly {
          readonly id: string;
          readonly users?: readonly unknown[];
          readonly matchers?: readonly unknown[];
        }[];
        readonly model?: unknown;
        readonly scoredMatcherDefaults?: unknown;
      };
    }[];
  }[];
};

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env[initCwdEnvKey];
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('manage portfolio wizard', () => {
  it('creates a new manifest and validates before saving', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');

    const result = await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
        createIfMissing: true,
      },
      createPromptApi({
        selects: ['add-analysis', 'save-exit'],
        inputs: ['plan-reviews', 'Plan Reviews', 'project-alpha', 'Project Alpha'],
        confirms: [true, true, false],
        editors: ['{"channels":[{"id":"C_ALPHA"}]}'],
      }),
    );

    expect(result.saved).toBe(true);
    expect(result.backupPath).toBeNull();
    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly analyses: readonly {
        readonly id: string;
        readonly runs: readonly { readonly id: string }[];
        readonly targets: readonly {
          readonly id: string;
          readonly analysisConfig: { readonly channels: readonly { readonly id: string }[] };
        }[];
      }[];
    };
    expect(saved.analyses[0]?.id).toBe('plan-reviews');
    expect(saved.analyses[0]?.runs[0]?.id).toBe('daily');
    expect(saved.analyses[0]?.targets[0]?.analysisConfig.channels[0]?.id).toBe('C_ALPHA');
  });

  it('archives a target and writes a timestamped backup before replacing an existing manifest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);

    const result = await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: ['set-target-status', 'plan-reviews\u0000project-alpha', 'archived', 'save-exit'],
        inputs: ['2026-06-09', 'project ended'],
      }),
    );

    expect(result.saved).toBe(true);
    expect(result.backupPath).toContain('portfolio.json.2026-06-10T12-00-00Z.bak');
    const files = await readdir(dir);
    expect(files.some((file) => file.endsWith('.bak'))).toBe(true);
    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as ReturnType<
      typeof createManifest
    >;
    expect(saved.analyses[0]?.targets[0]).toMatchObject({
      status: 'archived',
      endedOn: '2026-06-09',
      archiveReason: 'project ended',
    });
  });

  it('prints a dry-run plan preview without saving', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T21:00:00.000Z'),
      },
      createPromptApi({
        selects: ['preview', 'exit'],
      }),
    );

    expect(result.saved).toBe(false);
    expect(result.previewed).toBe(true);
    const plan = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly mode: string;
      readonly tasks: readonly { readonly targetId: string }[];
    };
    expect(plan.mode).toBe('dry-run');
    expect(plan.tasks.some((task) => task.targetId === 'project-alpha')).toBe(true);
  });

  it('resolves relative manifest paths from INIT_CWD when run through pnpm scripts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);
    process.env[initCwdEnvKey] = dir;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runManagePortfolioWizard(
      {
        manifest: 'portfolio.json',
        createIfMissing: false,
      },
      createPromptApi({
        selects: ['list', 'exit'],
      }),
    );

    const summary = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly analyses: readonly { readonly id: string }[];
    };
    expect(summary.analyses[0]?.id).toBe('plan-reviews');
  });

  it('does not silently create an empty manifest when creation is disabled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'missing.json');

    await expect(
      runManagePortfolioWizard(
        {
          manifest: manifestPath,
          createIfMissing: false,
        },
        createPromptApi({}),
      ),
    ).rejects.toThrow(`Portfolio manifest not found: ${manifestPath}`);
  });

  it('edits target channels with guided prompts and preserves other overrides', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const manifestPath = path.join(dir, 'portfolio.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT
      );
      CREATE TABLE channels (
        id TEXT,
        name TEXT
      );
      CREATE TABLE users (
        id TEXT,
        name TEXT
      );
      INSERT INTO channels VALUES ('C_ALPHA', 'alpha');
      INSERT INTO channels VALUES ('C_BETA', 'beta');
      INSERT INTO users VALUES ('U1', 'Alice');
      INSERT INTO users VALUES ('U2', 'Bob');
      INSERT INTO messages VALUES ('m1', 'C_ALPHA', '1', 'U1', 'alpha update');
      INSERT INTO messages VALUES ('m2', 'C_BETA', '2', 'U2', 'beta update');
    `);
    db.close();
    await writeFile(
      manifestPath,
      `${JSON.stringify(createManifestWithStorage(slacrawlPath), null, 2)}\n`,
    );

    const result = await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: [
          'edit-target-channels',
          'plan-reviews\u0000project-alpha',
          'engineer',
          'save-exit',
        ],
        confirms: [true, true, true, true, false, false, false],
        checkboxes: [[0], []],
        searchIndexes: [1, 0],
      }),
      async () => ({ text: '' }),
    );

    expect(result.saved).toBe(true);
    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as SavedPortfolio;
    const analysisConfig = saved.analyses[0]?.targets[0]?.analysisConfig;
    expect(analysisConfig?.context).toEqual({ maxMessages: 42 });
    expect(analysisConfig?.channels.map((channel) => channel.id)).toEqual(['C_ALPHA', 'C_BETA']);
    expect(analysisConfig?.channels[1]?.users).toEqual([
      { id: 'U2', name: 'Bob', role: 'engineer' },
    ]);
    expect(analysisConfig?.channels[1]?.matchers).toEqual([
      { id: 'existing', type: 'text', terms: ['existing'] },
    ]);
  });

  it('edits a target model override with guided prompts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(createManifestWithStorage(path.join(dir, 'slacrawl.db')), null, 2)}\n`,
    );

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: ['edit-target-model', 'plan-reviews\u0000project-alpha', 'save-exit'],
        confirms: [false],
        inputs: ['openrouter', 'anthropic/claude-test'],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as SavedPortfolio;
    expect(saved.analyses[0]?.targets[0]?.analysisConfig.model).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-test',
    });
  });

  it('edits target scored matcher defaults with guided prompts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(createManifestWithStorage(path.join(dir, 'slacrawl.db')), null, 2)}\n`,
    );

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: ['edit-target-scored-defaults', 'plan-reviews\u0000project-alpha', 'save-exit'],
        confirms: [true, true, true, true],
        inputs: ['openai', 'text-embedding-3-small', '', 'ollama', 'qwen3:0.6b', ''],
        numbers: [1000, 2000, 8],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as SavedPortfolio;
    expect(saved.analyses[0]?.targets[0]?.analysisConfig.scoredMatcherDefaults).toEqual({
      embeddings: {
        enabled: true,
        provider: 'openai',
        model: 'text-embedding-3-small',
        timeoutMs: 1000,
      },
      classifier: {
        enabled: true,
        provider: 'ollama',
        model: 'qwen3:0.6b',
        timeoutMs: 2000,
        maxInputMessages: 8,
      },
    });
  });

  it('returns to the main menu without saving when edit target is cancelled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);

    const result = await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: ['edit-target', 'plan-reviews\u0000project-alpha', '__back__', 'exit'],
      }),
    );

    expect(result.saved).toBe(false);
    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as ReturnType<
      typeof createManifest
    >;
    expect(saved.analyses[0]?.targets[0]?.name).toBe('Project Alpha');
  });

  it('does not persist portfolio common matchers into target channel overrides', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const manifestPath = path.join(dir, 'portfolio.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT
      );
      CREATE TABLE channels (
        id TEXT,
        name TEXT
      );
      CREATE TABLE users (
        id TEXT,
        name TEXT
      );
      INSERT INTO channels VALUES ('C_ALPHA', 'alpha');
      INSERT INTO users VALUES ('U1', 'Alice');
      INSERT INTO messages VALUES ('m1', 'C_ALPHA', '1', 'U1', 'alpha update');
    `);
    db.close();

    const manifest = {
      ...createManifestWithStorage(slacrawlPath),
      defaults: {
        ...createManifestWithStorage(slacrawlPath).defaults,
        matchers: {
          post: [
            {
              id: 'exclude_laughs',
              type: 'exclude',
              matcher: {
                id: 'laughs',
                type: 'text',
                terms: ['haha'],
              },
            },
          ],
        },
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: ['edit-target-channels', 'plan-reviews\u0000project-alpha', 'save-exit'],
        confirms: [true, true, false],
        checkboxes: [[0], []],
        searchIndexes: [0],
      }),
      async () => ({ text: '' }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as SavedPortfolio;
    const matchers = (saved.analyses[0]?.targets[0]?.analysisConfig.channels[0]?.matchers ??
      []) as readonly { readonly id?: string }[];
    expect(matchers.some((matcher) => matcher.id === 'exclude_laughs')).toBe(false);
    expect(matchers.some((matcher) => matcher.id === 'existing')).toBe(true);
  });

  it('prompts for guided runAndNotifyConfig when adding a target', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: ['add-target', 'plan-reviews', 'save-exit'],
        inputs: ['project-beta', 'Project Beta', 'Project Beta', 'manager@example.com'],
        confirms: [false, false, true, true, false],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly analyses: readonly {
        readonly targets: readonly {
          readonly id: string;
          readonly runAndNotifyConfig?: {
            readonly name?: string;
            readonly transports?: {
              readonly smtp?: {
                readonly host?: string;
                readonly to?: readonly string[];
              };
            };
          };
        }[];
      }[];
    };
    const beta = saved.analyses[0]?.targets.find((target) => target.id === 'project-beta');
    expect(beta?.runAndNotifyConfig?.name).toBeUndefined();
    expect(beta?.runAndNotifyConfig?.transports?.smtp?.to).toEqual(['manager@example.com']);
    expect(beta?.runAndNotifyConfig?.transports?.smtp?.host).toBeUndefined();
  });

  it('edits target runAndNotifyConfig from the edit target submenu', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: [
          'edit-target',
          'plan-reviews\u0000project-alpha',
          'notifications',
          'guided',
          '__back__',
          'save-exit',
        ],
        inputs: ['Project Alpha', 'alpha@example.com'],
        confirms: [true, false],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly analyses: readonly {
        readonly targets: readonly {
          readonly id: string;
          readonly runAndNotifyConfig?: {
            readonly transports?: {
              readonly smtp?: { readonly to?: readonly string[] };
            };
          };
        }[];
      }[];
    };
    expect(saved.analyses[0]?.targets[0]?.runAndNotifyConfig).toEqual({
      transports: {
        smtp: {
          to: ['alpha@example.com'],
        },
      },
    });
  });

  it('edits channel members from the edit target submenu', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const manifestPath = path.join(dir, 'portfolio.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT
      );
      CREATE TABLE channels (
        id TEXT,
        name TEXT
      );
      CREATE TABLE users (
        id TEXT,
        name TEXT
      );
      INSERT INTO channels VALUES ('C_ALPHA', 'alpha');
      INSERT INTO users VALUES ('U1', 'Alice');
      INSERT INTO users VALUES ('U2', 'Bob');
      INSERT INTO messages VALUES ('m1', 'C_ALPHA', '1', 'U1', 'alpha update');
      INSERT INTO messages VALUES ('m2', 'C_ALPHA', '2', 'U2', 'bob update');
    `);
    db.close();
    await writeFile(
      manifestPath,
      `${JSON.stringify(createManifestWithStorage(slacrawlPath), null, 2)}\n`,
    );

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: [
          'edit-target',
          'plan-reviews\u0000project-alpha',
          'channel-members',
          'C_ALPHA',
          'add',
          'engineer',
          'remove',
          '__back__',
          '__back__',
          '__back__',
          'save-exit',
        ],
        checkboxes: [['U1']],
        searchIndexes: [0],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as SavedPortfolio;
    expect(saved.analyses[0]?.targets[0]?.analysisConfig.channels[0]?.users).toEqual([
      { id: 'U2', name: 'Bob', role: 'engineer' },
    ]);
  });

  it('moves a member from every source channel to every destination channel', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createTwoTargetManifest(), null, 2)}\n`);

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: [
          'move-member',
          'plan-reviews\u0000project-alpha',
          'U1',
          'plan-reviews\u0000project-beta',
          'save-exit',
        ],
        confirms: [true],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly analyses: readonly {
        readonly targets: readonly {
          readonly id: string;
          readonly analysisConfig: {
            readonly channels: readonly {
              readonly id: string;
              readonly users?: readonly { readonly id: string; readonly role?: string }[];
            }[];
          };
        }[];
      }[];
    };
    const alpha = saved.analyses[0]?.targets.find((target) => target.id === 'project-alpha');
    const beta = saved.analyses[0]?.targets.find((target) => target.id === 'project-beta');
    expect(alpha?.analysisConfig.channels.map((channel) => channel.users ?? [])).toEqual([[], []]);
    expect(beta?.analysisConfig.channels.map((channel) => channel.users)).toEqual([
      [
        { id: 'U2', role: 'pm' },
        { id: 'U1', name: 'Alice', role: 'engineer' },
      ],
      [{ id: 'U1', name: 'Alice', role: 'engineer' }],
    ]);
  });

  it('applies member moves across all channels without duplicating existing members', () => {
    const manifest = createTwoTargetManifest();
    const moved = applyMemberMove({
      manifest,
      sourceAnalysisId: 'plan-reviews',
      sourceTargetId: 'project-alpha',
      destinationAnalysisId: 'plan-reviews',
      destinationTargetId: 'project-beta',
      member: { id: 'U1', name: 'Alice', role: 'engineer' },
    });
    type TargetChannels = {
      readonly analysisConfig?: {
        readonly channels?: readonly {
          readonly users?: readonly { readonly id: string }[];
        }[];
      };
    };
    const alpha = moved.analyses[0]?.targets.find((target) => target.id === 'project-alpha') as
      | TargetChannels
      | undefined;
    const beta = moved.analyses[0]?.targets.find((target) => target.id === 'project-beta') as
      | TargetChannels
      | undefined;
    expect(alpha?.analysisConfig?.channels?.map((channel) => channel.users ?? [])).toEqual([
      [],
      [],
    ]);
    expect(
      beta?.analysisConfig?.channels?.flatMap(
        (channel) => channel.users?.map((user) => user.id) ?? [],
      ),
    ).toEqual(['U2', 'U1', 'U1']);
  });

  it('edits runAndNotifyConfig with guided transport prompts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: [
          'edit-notifications',
          'target',
          'guided',
          'plan-reviews\u0000project-alpha',
          'save-exit',
        ],
        inputs: ['Project Alpha', 'alpha@example.com'],
        confirms: [true, false],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly analyses: readonly {
        readonly targets: readonly {
          readonly id: string;
          readonly runAndNotifyConfig?: {
            readonly name?: string;
            readonly transports?: {
              readonly smtp?: { readonly to?: readonly string[] };
            };
          };
        }[];
      }[];
    };
    expect(saved.analyses[0]?.targets[0]?.runAndNotifyConfig).toEqual({
      transports: {
        smtp: {
          to: ['alpha@example.com'],
        },
      },
    });
  });

  it('stores Slack unfurl disable flags from guided transport prompts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`);

    await runManagePortfolioWizard(
      {
        manifest: manifestPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      createPromptApi({
        selects: [
          'edit-notifications',
          'target',
          'guided',
          'plan-reviews\u0000project-alpha',
          'save-exit',
        ],
        inputs: ['Project Alpha', '#manager-reports'],
        // SMTP? no; Slack? yes; thread? yes; disable unfurl previews? yes
        confirms: [false, true, true, true],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly analyses: readonly {
        readonly targets: readonly {
          readonly runAndNotifyConfig?: {
            readonly transports?: {
              readonly slack?: {
                readonly enabled?: boolean;
                readonly defaultChannel?: string;
                readonly thread?: boolean;
                readonly unfurlLinks?: boolean;
                readonly unfurlMedia?: boolean;
              };
            };
          };
        }[];
      }[];
    };
    expect(saved.analyses[0]?.targets[0]?.runAndNotifyConfig).toEqual({
      transports: {
        slack: {
          enabled: true,
          defaultChannel: '#manager-reports',
          thread: true,
          unfurlLinks: false,
          unfurlMedia: false,
        },
      },
    });
  });

  it('registers the manage-portfolio command metadata', () => {
    expect(managePortfolioCommand.command).toBe('manage-portfolio');
    expect(managePortfolioCommand.describe).toContain('portfolio manifest');
  });
});

function createPromptApi(input: {
  readonly selects?: readonly unknown[] | undefined;
  readonly inputs?: readonly string[] | undefined;
  readonly confirms?: readonly boolean[] | undefined;
  readonly editors?: readonly string[] | undefined;
  readonly numbers?: readonly number[] | undefined;
  readonly checkboxes?: readonly unknown[][] | undefined;
  readonly searchIndexes?: readonly number[] | undefined;
}): PortfolioPromptApi {
  const selects = [...(input.selects ?? [])];
  const inputs = [...(input.inputs ?? [])];
  const confirms = [...(input.confirms ?? [])];
  const editors = [...(input.editors ?? [])];
  const numbers = [...(input.numbers ?? [])];
  const checkboxes = [...(input.checkboxes ?? [])];
  const searchIndexes = [...(input.searchIndexes ?? [])];
  return {
    select: vi.fn(async () => shift(selects, 'select')),
    input: vi.fn(async () => shift(inputs, 'input')),
    confirm: vi.fn(async () => shift(confirms, 'confirm')),
    editor: vi.fn(async () => shift(editors, 'editor')),
    number: vi.fn(async () => shift(numbers, 'number')),
    checkbox: vi.fn(async () => checkboxes.shift() ?? []),
    search: vi.fn(async (config: Parameters<PortfolioPromptApi['search']>[0]) => {
      const choices = await config.source(undefined, { signal: new AbortController().signal });
      const selectedIndex = searchIndexes.shift() ?? 0;
      const selected = choices[selectedIndex];
      if (selected && typeof selected === 'object' && 'value' in selected) {
        return selected.value;
      }
      return selected;
    }),
  } as unknown as PortfolioPromptApi;
}

function shift<T>(values: T[], label: string): T {
  const value = values.shift();
  if (value === undefined) {
    throw new Error(`No mocked ${label} value left`);
  }
  return value;
}

function createManifest() {
  return {
    schemaVersion: 1,
    defaults: {
      analysisConfig: {
        workspaceUrl: 'https://example.slack.com',
        prompts: ['@DEFAULT_BASE_INSTRUCTIONS@'],
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
      },
    },
    analyses: [
      {
        id: 'plan-reviews',
        name: 'Plan Reviews',
        runs: [
          {
            id: 'daily',
            schedule: { kind: 'workdays' },
            window: { date: 'today' },
          },
        ],
        targets: [
          {
            id: 'project-alpha',
            name: 'Project Alpha',
            status: 'active',
            analysisConfig: {
              channels: [{ id: 'C_ALPHA' }],
            },
          },
        ],
      },
    ],
  } as const;
}

function createManifestWithStorage(slacrawlPath: string) {
  return {
    schemaVersion: 1,
    defaults: {
      analysisConfig: {
        storage: {
          slacrawlDatabasePath: slacrawlPath,
        },
        workspaceUrl: 'https://example.slack.com',
        prompts: ['@DEFAULT_BASE_INSTRUCTIONS@'],
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
      },
    },
    analyses: [
      {
        id: 'plan-reviews',
        name: 'Plan Reviews',
        targets: [
          {
            id: 'project-alpha',
            name: 'Project Alpha',
            status: 'active',
            analysisConfig: {
              context: { maxMessages: 42 },
              channels: [
                {
                  id: 'C_ALPHA',
                  users: [{ id: 'U1', role: 'engineer' }],
                  matchers: [{ id: 'existing', type: 'text', terms: ['existing'] }],
                },
              ],
            },
          },
        ],
      },
    ],
  } as const;
}

function createTwoTargetManifest() {
  return {
    schemaVersion: 1,
    defaults: {
      analysisConfig: {
        workspaceUrl: 'https://example.slack.com',
        prompts: ['@DEFAULT_BASE_INSTRUCTIONS@'],
        model: {
          provider: 'openai',
          model: 'gpt-test',
        },
      },
    },
    analyses: [
      {
        id: 'plan-reviews',
        name: 'Plan Reviews',
        targets: [
          {
            id: 'project-alpha',
            name: 'Project Alpha',
            status: 'active',
            analysisConfig: {
              channels: [
                {
                  id: 'C_ALPHA',
                  users: [{ id: 'U1', name: 'Alice', role: 'engineer' }],
                },
                {
                  id: 'C_ALPHA_DM',
                  users: [{ id: 'U1', name: 'Alice', role: 'engineer' }],
                },
              ],
            },
          },
          {
            id: 'project-beta',
            name: 'Project Beta',
            status: 'active',
            analysisConfig: {
              channels: [
                {
                  id: 'C_BETA',
                  users: [{ id: 'U2', role: 'pm' }],
                },
                {
                  id: 'C_BETA_DM',
                },
              ],
            },
          },
        ],
      },
    ],
  } as const;
}
