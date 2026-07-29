import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { readSlacrawlDirectory } from '../src/slacrawl/directory.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('readSlacrawlDirectory', () => {
  it('prefers metadata tables and falls back to message channel users', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-directory-'));
    tempDirs.push(dir);
    const slacrawlPath = path.join(dir, 'slacrawl.db');
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
        type TEXT,
        is_private INTEGER
      );
      CREATE TABLE users (
        id TEXT,
        real_name TEXT
      );
      INSERT INTO messages VALUES ('m1', 'C1', '1', 'U1', 'hello');
      INSERT INTO messages VALUES ('m2', 'C1', '2', 'U2', 'hello');
      INSERT INTO channels VALUES ('C1', 'team-planning', 'channel', 1);
      INSERT INTO users VALUES ('U1', 'Alice');
    `);
    db.close();

    const directory = readSlacrawlDirectory(slacrawlPath, [
      { id: 'C_REF', name: 'from-reference', users: [{ id: 'U_REF', name: 'Ref User' }] },
    ]);

    expect(directory.channels.find((channel) => channel.id === 'C1')).toMatchObject({
      name: 'team-planning',
      kind: 'channel',
      isPrivate: true,
      source: 'metadata',
    });
    expect(directory.channels.find((channel) => channel.id === 'C_REF')?.name).toBe(
      'from-reference',
    );
    expect(directory.users.find((user) => user.id === 'U1')?.name).toBe('Alice');
    expect(directory.users.find((user) => user.id === 'U_REF')?.name).toBe('Ref User');
    expect(directory.channelUserIds.get('C1')).toEqual(['U1', 'U2']);
  });
});
