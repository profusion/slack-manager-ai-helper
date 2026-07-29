import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editConfigCommand } from '../src/commands/edit-config.js';
import {
  parseScoredMatcherSuggestion,
  suggestScoredMatcher,
} from '../src/config-wizard/suggestions.js';
import {
  type PromptApi,
  runCreateConfigWizard,
  runEditConfigWizard,
} from '../src/config-wizard/wizard.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('config wizard', () => {
  it('registers the edit-config command metadata', () => {
    expect(editConfigCommand.command).toBe('edit-config');
    expect(editConfigCommand.describe).toContain('edit a topic JSON config');
  });

  it('edits a config in place, writes a backup, and copies reference matchers', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-edit-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const configPath = path.join(dir, 'topic-config.json');
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
      INSERT INTO channels VALUES ('C1', 'reference');
      INSERT INTO channels VALUES ('C2', 'delivery');
      INSERT INTO users VALUES ('U1', 'Alice');
      INSERT INTO users VALUES ('U2', 'Bob');
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'reference update');
      INSERT INTO messages VALUES ('m2', 'C2', '2', 'U2', 'delivery update');
    `);
    db.close();
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [
            {
              id: 'C1',
              users: [{ id: 'U1', role: 'engineer' }],
              matchers: [{ id: 'existing', type: 'text', terms: ['existing'] }],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, false, false, true, true, false, false, false, false],
      select: ['engineer'],
      input: [],
      editor: [],
      checkbox: [[0], []],
      searchIndexes: [0, 0],
    });

    const result = await runEditConfigWizard(
      {
        config: configPath,
        now: new Date('2026-06-10T12:00:00.000Z'),
      },
      prompts,
      async () => ({ text: '' }),
    );

    expect(result.backupPath).toContain('topic-config.json.2026-06-10T12-00-00Z.bak');
    expect(await readFile(result.backupPath, 'utf8')).toContain('"id": "C1"');
    expect(prompts.messages).toEqual(
      expect.arrayContaining([expect.stringContaining('Copy matchers from reference')]),
    );
    const edited = JSON.parse(await readFile(configPath, 'utf8')) as {
      readonly channels: readonly {
        readonly id: string;
        readonly users?: readonly { readonly role?: string }[];
        readonly matchers?: readonly { readonly id: string }[];
      }[];
    };
    expect(edited.channels.map((channel) => channel.id)).toEqual(['C1', 'C2']);
    expect(edited.channels[1]?.matchers).toEqual([
      { id: 'existing', type: 'text', terms: ['existing'] },
    ]);
  });

  it('generates a valid config from a reference with mocked prompts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
        name TEXT,
        type TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'planning update');
      INSERT INTO messages VALUES ('m2', 'C1', '2', 'U2', 'planning follow-up');
      INSERT INTO channels VALUES ('C1', 'team-planning', 'channel');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, false, true, true, true, false, true, false, false, false, false],
      select: ['', '', 'text'],
      input: ['planning'],
      editor: ['plan\nplanning'],
      checkbox: [[]],
    });

    const result = await runCreateConfigWizard(
      { reference: referencePath, output: outputPath },
      prompts,
      async () => ({ text: '' }),
    );
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels: readonly {
        readonly id: string;
        readonly users: readonly { readonly id: string }[];
        readonly matchers: readonly { readonly type: string; readonly terms: readonly string[] }[];
      }[];
    };

    expect(result.outputPath).toBe(outputPath);
    expect(created.channels[0]?.id).toBe('C1');
    expect(created.channels[0]?.users.map((user) => user.id)).toEqual(['U1', 'U2']);
    expect(created.channels[0]?.matchers[0]).toMatchObject({
      type: 'text',
      terms: ['plan', 'planning'],
    });
    expect(prompts.messages).toContain('Add user filter for channel C1 (#team-planning)?');
    expect(
      prompts.confirmCalls.find(
        (entry) => entry.message === 'Add user filter for channel C1 (#team-planning)?',
      )?.default,
    ).toBe(true);
    expect(prompts.messages).toContain('Add matcher for channel C1 (#team-planning)?');
    const userSearches = prompts.searchChoices.filter(
      (entry) => entry.message === 'Search user for channel C1 (#team-planning)',
    );
    expect(userSearches.map((entry) => entry.names)).toEqual([
      ['U1', 'U2', 'Cancel adding user filter'],
      ['U2', 'Cancel adding user filter'],
    ]);
    expect(result.previewRan).toBe(false);
  });

  it('can cancel a user filter after choosing to add one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-cancel-user-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'planning update');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, true, true, true, false, false, false, false],
      select: [],
      input: [],
      editor: [],
      checkbox: [[]],
      searchIndexes: [0, 1],
    });

    await runCreateConfigWizard(
      { reference: referencePath, output: outputPath },
      prompts,
      async () => ({ text: '' }),
    );
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels: readonly { readonly users?: unknown }[];
    };

    expect(prompts.searchChoices[1]?.names).toEqual(['U1', 'Cancel adding user filter']);
    expect(created.channels[0]).not.toHaveProperty('users');
  });

  it('can edit a matcher after reviewing pasted sample results', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-edit-matcher-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'hello world');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, false, true, false, true, true, false, true, true, false, false, false],
      select: ['text'],
      input: ['greeting'],
      editor: ['too-specific', 'hello world', 'hello', 'hello world'],
      checkbox: [[]],
    });

    const stdout = captureStdout();
    try {
      await runCreateConfigWizard(
        { reference: referencePath, output: outputPath },
        prompts,
        async () => ({ text: '' }),
      );
    } finally {
      stdout.restore();
    }
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels: readonly {
        readonly matchers: readonly { readonly id: string; readonly terms: readonly string[] }[];
      }[];
    };

    expect(prompts.confirmCalls.filter((entry) => entry.message === 'Is this matcher OK?')).toEqual(
      [
        { message: 'Is this matcher OK?', default: true },
        { message: 'Is this matcher OK?', default: true },
      ],
    );
    expect(stdout.text()).toContain('MISS hello world');
    expect(stdout.text()).toContain('MATCH hello world');
    expect(created.channels[0]?.matchers).toEqual([
      { id: 'greeting', type: 'text', terms: ['hello'] },
    ]);
  });

  it('reviews regex matcher samples when flags omit global', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-regex-review-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'hello world');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, false, true, false, true, true, true, false, false, false],
      select: ['regex'],
      input: ['greeting-regex', 'hello', 'iu'],
      editor: ['hello hello'],
      checkbox: [[]],
    });

    const stdout = captureStdout();
    try {
      await runCreateConfigWizard(
        { reference: referencePath, output: outputPath },
        prompts,
        async () => ({ text: '' }),
      );
    } finally {
      stdout.restore();
    }
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels: readonly {
        readonly matchers: readonly {
          readonly id: string;
          readonly type: string;
          readonly pattern: string;
          readonly flags: string;
        }[];
      }[];
    };

    expect(stdout.text()).toContain('MATCH hello hello');
    expect(created.channels[0]?.matchers).toEqual([
      { id: 'greeting-regex', type: 'regex', pattern: 'hello', flags: 'iu' },
    ]);
  });

  it('can cancel adding a matcher after opening matcher type selection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-cancel-matcher-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'hello world');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, true, true, false, true, false, false, false],
      select: ['cancel'],
      input: [],
      editor: [],
      checkbox: [[]],
    });

    await runCreateConfigWizard(
      { reference: referencePath, output: outputPath },
      prompts,
      async () => ({ text: '' }),
    );
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels: readonly { readonly matchers?: unknown }[];
    };

    expect(prompts.selectChoices.find((entry) => entry.message === 'Matcher type')?.names).toEqual([
      'Text terms',
      'Regular expression',
      'Mention',
      'Scored',
      'Exclude wrapper',
      'Cancel adding matcher',
    ]);
    expect(created.channels[0]).not.toHaveProperty('matchers');
  });

  it('guides exclude wrapper children and prevents nested exclude selection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-exclude-child-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'hello world');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, true, true, false, true, false, false, false, false],
      select: ['exclude', 'text'],
      input: ['suppress-planning', 'planning-text'],
      editor: ['planning'],
      checkbox: [[]],
    });

    const stdout = captureStdout();
    try {
      await runCreateConfigWizard(
        { reference: referencePath, output: outputPath },
        prompts,
        async () => ({ text: '' }),
      );
    } finally {
      stdout.restore();
    }
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels: readonly {
        readonly matchers: readonly {
          readonly id: string;
          readonly type: string;
          readonly matcher: {
            readonly id: string;
            readonly type: string;
            readonly terms: string[];
          };
        }[];
      }[];
    };
    const matcherTypeChoices = prompts.selectChoices.filter(
      (entry) => entry.message === 'Matcher type',
    );

    expect(stdout.text()).toContain(
      'Select the matcher that should suppress messages. When this child matcher matches, the message is excluded from anchor matches and model evidence.',
    );
    expect(matcherTypeChoices[0]?.names).toContain('Exclude wrapper');
    expect(matcherTypeChoices[1]?.names).toEqual([
      'Text terms',
      'Regular expression',
      'Mention',
      'Scored',
      'Cancel adding matcher',
    ]);
    expect(created.channels[0]?.matchers).toEqual([
      {
        id: 'suppress-planning',
        type: 'exclude',
        matcher: { id: 'planning-text', type: 'text', terms: ['planning'] },
      },
    ]);
  });

  it('parses strict scored matcher JSON suggestions', () => {
    expect(
      parseScoredMatcherSuggestion(
        '{"question":"Is this an action?","keywords":["todo"],"phrases":["please do"],"patterns":["\\\\bETA\\\\b"]}',
      ),
    ).toEqual({
      question: 'Is this an action?',
      keywords: ['todo'],
      phrases: ['please do'],
      patterns: ['\\bETA\\b'],
    });
  });

  it('offers reference matchers when adding a reference channel', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-copy-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'existing topic');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [
            {
              id: 'C1',
              matchers: [{ id: 'existing', type: 'text', terms: ['existing'] }],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, false, true, false, false, false, false],
      select: [],
      input: [],
      editor: [],
      checkbox: [[0], []],
    });

    await runCreateConfigWizard(
      { reference: referencePath, output: outputPath },
      prompts,
      async () => ({ text: '' }),
    );
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels: readonly {
        readonly matchers: readonly { readonly id: string; readonly terms: readonly string[] }[];
      }[];
    };

    expect(prompts.messages).toContain(
      'Copy matchers from reference for channel C1 (#team-planning)',
    );
    expect(created.channels[0]?.matchers).toEqual([
      { id: 'existing', type: 'text', terms: ['existing'] },
    ]);
  });

  it('offers reference channel roles when adding an unrelated channel', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-roles-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO channels VALUES ('C2', 'delivery');
      INSERT INTO channels VALUES ('C1', 'reference');
      INSERT INTO users VALUES ('U3', 'Carol');
      INSERT INTO users VALUES ('U1', 'Alice');
      INSERT INTO messages VALUES ('m1', 'C2', '1', 'U3', 'delivery update');
      INSERT INTO messages VALUES ('m2', 'C1', '2', 'U1', 'reference update');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [
            {
              id: 'C1',
              users: [
                { id: 'U1', role: 'engineer' },
                { id: 'U2', role: 'manager' },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, false, true, true, false, false, false, false, false],
      select: ['engineer'],
      input: [],
      editor: [],
      checkbox: [[]],
    });

    await runCreateConfigWizard(
      { reference: referencePath, output: outputPath },
      prompts,
      async () => ({ text: '' }),
    );
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels: readonly {
        readonly id: string;
        readonly users: readonly { readonly id: string; readonly role?: string }[];
      }[];
    };

    const rolePrompt = prompts.selectChoices.find(
      (entry) => entry.message === 'Role for user U3 (Carol)',
    );
    expect(rolePrompt?.names).toEqual(['engineer', 'manager', 'No role', 'Add new role']);
    expect(created.channels[0]?.id).toBe('C2');
    expect(created.channels[0]?.users).toEqual([{ id: 'U3', name: 'Carol', role: 'engineer' }]);
  });

  it('confirms a two-day preview range when no date range is provided', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-preview-range-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1780660800', 'U1', 'planning update');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [{ id: 'C1' }],
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, true, false, false, true, true, false],
      select: [],
      input: [],
      editor: [],
      checkbox: [[]],
    });

    const stdout = captureStdout();
    let result: Awaited<ReturnType<typeof runCreateConfigWizard>>;
    try {
      result = await runCreateConfigWizard(
        { reference: referencePath, output: outputPath },
        prompts,
        async () => ({ text: '' }),
      );
    } finally {
      stdout.restore();
    }

    expect(result.previewRan).toBe(true);
    expect(stdout.text()).toContain(`Match preview
Scanned: 1
Matched anchors: 1
Evidence messages: 1

Matched anchors
Channel C1
2026-06-05
  09:00 MATCH channel:channel U1: planning update`);
    expect(stdout.text()).toContain(`Evidence
Channel C1
2026-06-05
  09:00 MATCH U1: planning update`);
    expect(stdout.text()).toContain('No ignored messages in scanned input.');
    expect(prompts.confirmCalls).toContainEqual({
      message:
        'No date range was provided. Test only the last 2 local days (2026-06-04 through 2026-06-05)?',
      default: true,
    });
    expect(prompts.confirmCalls).toContainEqual({
      message: 'Dry-run analysis model and show report?',
      default: false,
    });
  });

  it('defaults the preview range to the latest available Slack message date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-preview-latest-db-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1780480800', 'U1', 'planning update');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [{ id: 'C1' }],
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, true, false, false, true, true, false],
      select: [],
      input: [],
      editor: [],
      checkbox: [[]],
    });

    const stdout = captureStdout();
    try {
      await runCreateConfigWizard(
        { reference: referencePath, output: outputPath },
        prompts,
        async () => ({ text: '' }),
      );
    } finally {
      stdout.restore();
    }

    expect(prompts.confirmCalls).toContainEqual({
      message:
        'No date range was provided. Test only the last 2 local days (2026-06-02 through 2026-06-03)?',
      default: true,
    });
  });

  it('explains why a test report is skipped when preview has no in-range matches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-no-report-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1778068800', 'U1', 'planning update');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [{ id: 'C1' }],
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, true, false, false, true, true, true],
      select: [],
      input: [],
      editor: [],
      checkbox: [[]],
    });

    const stdout = captureStdout();
    try {
      await runCreateConfigWizard(
        {
          reference: referencePath,
          output: outputPath,
          dateRange: { startDate: '2026-06-04', endDate: '2026-06-05' },
        },
        prompts,
        async () => ({ text: '' }),
      );
    } finally {
      stdout.restore();
    }

    expect(prompts.confirmCalls).toContainEqual({
      message:
        'No test report can be generated because preview found no matched messages. Continue without a test report?',
      default: true,
    });
    expect(prompts.confirmCalls).not.toContainEqual({
      message: 'Dry-run analysis model and show report?',
      default: false,
    });
  });

  it('returns to editing when the user does not continue without a test report', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-edit-after-no-report-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
      INSERT INTO messages VALUES ('m1', 'C1', '1778068800', 'U1', 'planning update');
      INSERT INTO channels VALUES ('C1', 'team-planning');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [{ id: 'C1' }],
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, true, false, false, true, false, true, false, false, false],
      select: [],
      input: [],
      editor: [],
      checkbox: [[]],
    });

    const stdout = captureStdout();
    try {
      await runCreateConfigWizard(
        {
          reference: referencePath,
          output: outputPath,
          dateRange: { startDate: '2026-06-04', endDate: '2026-06-05' },
        },
        prompts,
        async () => ({ text: '' }),
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.text()).toContain('Returning to channel and context editing.');
    expect(
      prompts.confirmCalls.filter((entry) => entry.message === 'Start from reference channels?'),
    ).toEqual([
      { message: 'Start from reference channels?', default: true },
      { message: 'Start from reference channels?', default: true },
    ]);
  });

  it('rebases relative reference paths for storage and referenced prompts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-rebase-'));
    tempDirs.push(dir);
    const referenceDir = path.join(dir, 'tmp');
    await mkdir(referenceDir, { recursive: true });
    const slacrawlPath = path.join(referenceDir, 'slacrawl.db');
    const promptPath = path.join(referenceDir, 'PROMPT.md');
    const referencePath = path.join(referenceDir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
    const db = new DatabaseSync(slacrawlPath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT,
        channel_id TEXT,
        ts TEXT,
        user_id TEXT,
        text TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'hello');
    `);
    db.close();
    await writeFile(promptPath, '# Prompt\n');
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: 'slacrawl.db' },
          workspaceUrl: 'https://example.slack.com',
          prompts: 'PROMPT.md',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [{ id: 'C1' }],
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, true, false, false],
      select: ['reference'],
      input: [],
      editor: [],
      checkbox: [[]],
    });

    await runCreateConfigWizard(
      { reference: referencePath, output: outputPath },
      prompts,
      async () => ({ text: '' }),
    );
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly storage: { readonly slacrawlDatabasePath: string };
      readonly workspaceUrl: string;
      readonly prompts: string;
    };

    expect(created.storage.slacrawlDatabasePath).toBe(path.join('tmp', 'slacrawl.db'));
    expect(created.prompts).toBe(path.join('tmp', 'PROMPT.md'));
  });

  it('omits empty optional arrays after removing all channels during synthetic suggestions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-wizard-empty-channels-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
    const referencePath = path.join(dir, 'reference-config.json');
    const outputPath = path.join(dir, 'created-config.json');
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
        name TEXT,
        type TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'planning update');
      INSERT INTO channels VALUES ('C1', 'team-planning', 'channel');
    `);
    db.close();
    await writeFile(
      referencePath,
      `${JSON.stringify(
        {
          storage: { slacrawlDatabasePath: slacrawlPath },
          workspaceUrl: 'https://example.slack.com',
          prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
          model: { provider: 'openai', model: 'gpt-test' },
          channels: [{ id: 'C1' }],
          globalMatchers: [],
          context: {
            syntheticThreads: {
              enabled: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const prompts = mockedPrompts({
      confirm: [true, false, true, false, true, true, false],
      select: [],
      input: [],
      editor: ['Keywords: PR review\n\nReply markers:\n- Vou dar uma olhada.'],
      checkbox: [['C1']],
    });

    await runCreateConfigWizard(
      { reference: referencePath, output: outputPath },
      prompts,
      async () => ({ text: 'Keywords: PR review' }),
    );
    const created = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly channels?: unknown;
      readonly globalMatchers?: unknown;
    };

    expect(created).not.toHaveProperty('channels');
    expect(created).not.toHaveProperty('globalMatchers');
  });

  it('sends relevant and irrelevant samples to the main model for scored suggestions', async () => {
    const generateText = vi.fn(async (_input: { readonly prompt: string }) => ({
      text: '{"question":"Is this a blocker?","keywords":["blocked"],"phrases":[],"patterns":[]}',
    }));

    const suggestion = await suggestScoredMatcher(
      {
        workspaceUrl: 'https://example.slack.com',
        prompts: '@DEFAULT_BASE_INSTRUCTIONS@',
        model: { provider: 'openai', model: 'gpt-test' },
      },
      {
        relevantSamples: ['blocked by auth'],
        irrelevantSamples: ['shipped auth'],
      },
      generateText,
    );

    expect(suggestion.question).toBe('Is this a blocker?');
    const firstCall = generateText.mock.calls[0]?.[0];
    expect(firstCall?.prompt).toContain('blocked by auth');
    expect(firstCall?.prompt).toContain('shipped auth');
  });
});

function mockedPrompts(answers: {
  readonly confirm: boolean[];
  readonly select: string[];
  readonly input: string[];
  readonly editor: string[];
  readonly checkbox: unknown[][];
  readonly searchIndexes?: number[] | undefined;
}): PromptApi & {
  readonly messages: string[];
  readonly confirmCalls: readonly {
    readonly message: string;
    readonly default?: boolean | undefined;
  }[];
  readonly selectChoices: readonly {
    readonly message: string;
    readonly names: readonly string[];
  }[];
  readonly searchChoices: readonly {
    readonly message: string;
    readonly names: readonly string[];
  }[];
} {
  const messages: string[] = [];
  const confirmCalls: { readonly message: string; readonly default?: boolean | undefined }[] = [];
  const selectChoices: { readonly message: string; readonly names: readonly string[] }[] = [];
  const searchChoices: { readonly message: string; readonly names: readonly string[] }[] = [];
  return {
    messages,
    confirmCalls,
    selectChoices,
    searchChoices,
    confirm: vi.fn(async (config: { readonly message: string; readonly default?: boolean }) => {
      messages.push(config.message);
      confirmCalls.push({ message: config.message, default: config.default });
      return answers.confirm.shift() ?? false;
    }) as PromptApi['confirm'],
    select: vi.fn(
      async (config: {
        readonly message: string;
        readonly choices?: readonly { readonly name?: string; readonly value?: unknown }[];
      }) => {
        messages.push(config.message);
        selectChoices.push({
          message: config.message,
          names: (config.choices ?? []).map((choice) => String(choice.name ?? choice.value)),
        });
        return answers.select.shift() ?? '';
      },
    ) as PromptApi['select'],
    input: vi.fn(async (config: { readonly message: string }) => {
      messages.push(config.message);
      return answers.input.shift() ?? '';
    }) as PromptApi['input'],
    editor: vi.fn(async () => answers.editor.shift() ?? '') as PromptApi['editor'],
    checkbox: vi.fn(async (config: { readonly message: string }) => {
      messages.push(config.message);
      return answers.checkbox.shift() ?? [];
    }) as PromptApi['checkbox'],
    number: vi.fn(
      async (config: { readonly default?: number }) => config.default,
    ) as PromptApi['number'],
    search: vi.fn(async (config: Parameters<PromptApi['search']>[0]) => {
      messages.push(config.message);
      const choices = await config.source(undefined, { signal: new AbortController().signal });
      searchChoices.push({
        message: config.message,
        names: choices
          .map((choice) =>
            choice && typeof choice === 'object' && 'name' in choice
              ? String(choice.name)
              : undefined,
          )
          .filter((name) => name !== undefined),
      });
      const selectable = choices.filter(
        (choice) => !(choice instanceof Object && 'type' in choice),
      );
      const selectedIndex = answers.searchIndexes?.shift() ?? 0;
      const first = selectable[selectedIndex];
      if (first && typeof first === 'object' && 'value' in first) {
        return first.value;
      }
      return first;
    }) as PromptApi['search'],
  };
}

function captureStdout(): { readonly text: () => string; readonly restore: () => void } {
  let output = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  });
  return {
    text: () => output,
    restore: () => {
      spy.mockRestore();
    },
  };
}
