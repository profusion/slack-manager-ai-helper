import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { collectModelInput } from '../src/collect-model-input.js';
import { loadConfig } from '../src/config/load-config.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('collectModelInput', () => {
  it('prints compiled model input without creating or updating state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-collect-'));
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
    const result = await collectModelInput(
      {
        ...resolved,
        config: {
          ...resolved.config,
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
      { dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' } },
    );

    expect(result.modelCalled).toBe(true);
    expect(result.modelInput?.system).toContain('Daily Planning Review');
    expect(result.modelInput?.system).toContain('# STRUCTURED OUTPUT CONTRACT');
    expect(result.modelInput?.system.match(/```jsonschema/gu)).toBeNull();
    expect(result.modelInput?.prompt).toContain('Planning auth work today');
    expect(result.modelInput?.prompt).toContain('"topicId":"plan-reviews"');
    expect(result.modelInput?.prompt).toContain(
      '"href":"https://example.slack.com/archives/C_PLANNING/p1000"',
    );
    expect(result.modelInput?.prompt).toContain(
      '"authoredTopLevelMessages":["https://example.slack.com/archives/C_PLANNING/p1000"]',
    );
    await expect(access(statePath, constants.F_OK)).rejects.toThrow();
  });

  it('includes thread_ts in model-input hrefs for thread replies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-collect-'));
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
    const result = await collectModelInput(
      {
        ...resolved,
        config: {
          ...resolved.config,
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
      { dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' } },
    );

    const replyHref = 'https://example.slack.com/archives/C_PLANNING/p1002?thread_ts=1001';
    expect(result.modelCalled).toBe(true);
    expect(result.modelInput?.prompt).toContain(`"href":"${replyHref}"`);
    expect(result.modelInput?.prompt).toContain(`"authoredReplies":["${replyHref}"]`);
    expect(result.modelInput?.prompt).toContain(`"ownedEvidence":["${replyHref}"]`);
    await expect(access(statePath, constants.F_OK)).rejects.toThrow();
  });

  it('returns a JSON reason when no model input would be sent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-collect-'));
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
        thread_ts TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C_PLANNING', '1000', 'U_ALICE', 'No matching content here', NULL);
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const result = await collectModelInput(
      {
        ...resolved,
        config: {
          ...resolved.config,
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
      { dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' } },
    );

    expect(result).toMatchObject({
      modelCalled: false,
      reason: 'no_matches',
    });
    expect(result).not.toHaveProperty('modelInput');
  });

  it('can print compact state before prompt compilation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-collect-'));
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
    const result = await collectModelInput(
      {
        ...resolved,
        config: {
          ...resolved.config,
          prompts: ['/missing/prompt.md'],
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
      { stateOnly: true, dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' } },
    );

    expect(result.modelCalled).toBe(true);
    expect(result).not.toHaveProperty('modelInput');
    expect(result.state?.topicId).toBe('plan-reviews');
    expect(result.state?.timeline[0]?.channels[0]?.threads[0]?.messages[0]?.text).toBe(
      'Planning auth work today',
    );
    expect(result.state?.timeline[0]?.channels[0]?.threads[0]?.messages[0]?.href).toBe(
      'https://example.slack.com/archives/C_PLANNING/p1000',
    );
    await expect(access(statePath, constants.F_OK)).rejects.toThrow();
  });
});
