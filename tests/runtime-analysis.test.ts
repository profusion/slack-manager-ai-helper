import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/load-config.js';
import { prepareAnalysisRuntime, todayStartCursor } from '../src/runtime/analysis.js';

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

describe('prepareAnalysisRuntime', () => {
  it('uses the redacted slacrawl read path and does not write state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-runtime-'));
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
      INSERT INTO messages VALUES (
        'm1',
        'C_PLANNING',
        '1000',
        'U_ALICE',
        'Planning with Bearer abc.def.ghi',
        NULL
      );
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const prepared = await prepareAnalysisRuntime(
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
            syntheticThreads: { enabled: false },
          },
        },
      },
      { dateRange: { startDate: '1969-12-31', endDate: '1969-12-31' } },
    );

    expect(prepared.messages[0]?.text).toContain('[REDACTED]');
    expect(prepared.matches[0]?.message.text).toContain('[REDACTED]');
    expect(JSON.stringify(prepared)).not.toContain('Bearer abc.def.ghi');
    await expect(access(statePath, constants.F_OK)).rejects.toThrow();
  });

  it('filters matches and diagnostics by date range before expanding evidence', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-runtime-date-range-'));
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
      INSERT INTO messages VALUES (
        'old',
        'C_PLANNING',
        '1778068800',
        'U_ALICE',
        'Planning from an older day',
        NULL
      );
      INSERT INTO messages VALUES (
        'current',
        'C_PLANNING',
        '1780660800',
        'U_ALICE',
        'Planning inside the selected day',
        NULL
      );
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const prepared = await prepareAnalysisRuntime(
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
            includeRealThread: false,
            nearbyMessagesBeforeMinutes: 0,
            nearbyMessagesAfterMinutes: 0,
            syntheticThreads: { enabled: false },
          },
        },
      },
      { dateRange: { startDate: '2026-06-05', endDate: '2026-06-05' } },
    );

    expect(prepared.reason).toBeUndefined();
    expect(prepared.matches.map((match) => match.message.messageId)).toEqual(['current']);
    expect(prepared.diagnostics.map((diagnostic) => diagnostic.message.messageId)).toEqual([
      'current',
    ]);
    expect(prepared.evidence.map((message) => message.messageId)).toEqual(['current']);
  });

  it('defaults first implicit scans to local today', async () => {
    // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
    process.env['TZ'] = 'America/Sao_Paulo';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T15:00:00.000Z'));
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-runtime-today-'));
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
      INSERT INTO messages VALUES (
        'yesterday',
        'C_PLANNING',
        '1780628399',
        'U_ALICE',
        'Planning from yesterday',
        NULL
      );
      INSERT INTO messages VALUES (
        'morning',
        'C_PLANNING',
        '1780628400',
        'U_ALICE',
        'Planning from local midnight',
        NULL
      );
      INSERT INTO messages VALUES (
        'latest',
        'C_PLANNING',
        '1780671600',
        'U_ALICE',
        'Planning near latest message',
        NULL
      );
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const prepared = await prepareAnalysisRuntime({
      ...resolved,
      config: {
        ...resolved.config,
        storage: {
          slacrawlDatabasePath: slacrawlPath,
          statePath,
        },
        context: {
          ...resolved.config.context,
          includeRealThread: false,
          nearbyMessagesBeforeMinutes: 0,
          nearbyMessagesAfterMinutes: 0,
          syntheticThreads: { enabled: false },
        },
      },
    });

    expect(todayStartCursor('America/Sao_Paulo')).toBe('1780628399.999');
    expect(prepared.messages.map((message) => message.messageId)).toEqual(['morning', 'latest']);
    expect(prepared.matches.map((match) => match.message.messageId)).toEqual(['morning', 'latest']);
  });

  it('uses an explicit date range as deterministic scan bounds', async () => {
    // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111.
    process.env['TZ'] = 'America/Sao_Paulo';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T15:00:00.000Z'));
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-runtime-date-cursor-'));
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
      INSERT INTO messages VALUES (
        'before-range',
        'C_PLANNING',
        '1780541999',
        'U_ALICE',
        'Planning before selected date',
        NULL
      );
      INSERT INTO messages VALUES (
        'selected',
        'C_PLANNING',
        '1780542000',
        'U_ALICE',
        'Planning on selected date',
        NULL
      );
      INSERT INTO messages VALUES (
        'today',
        'C_PLANNING',
        '1780628400',
        'U_ALICE',
        'Planning from today',
        NULL
      );
    `);
    db.close();

    const resolved = await loadConfig('examples/plan-reviews-config.json');
    const prepared = await prepareAnalysisRuntime(
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
            includeRealThread: false,
            nearbyMessagesBeforeMinutes: 0,
            nearbyMessagesAfterMinutes: 0,
            syntheticThreads: { enabled: false },
          },
        },
      },
      { dateRange: { startDate: '2026-06-04', endDate: '2026-06-04' } },
    );

    expect(prepared.messages.map((message) => message.messageId)).toEqual(['selected']);
    expect(prepared.matches.map((match) => match.message.messageId)).toEqual(['selected']);
  });
});
