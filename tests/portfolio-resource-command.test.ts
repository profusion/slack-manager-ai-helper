import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPortfolioResource } from '../src/commands/portfolio-resource.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fixture() {
  return {
    schemaVersion: 1 as const,
    analyses: [
      {
        id: 'people',
        name: 'People',
        targets: [
          {
            id: 'a',
            name: 'A',
            status: 'active',
            analysisConfig: {
              channels: [
                { id: 'C1', name: 'one', users: [{ id: 'U1', name: 'Ada', role: 'lead' }] },
                { id: 'C3', users: [{ id: 'U1', name: 'Ada', role: 'lead' }] },
              ],
            },
          },
          {
            id: 'b',
            name: 'B',
            status: 'active',
            analysisConfig: {
              channels: [{ id: 'C2', name: 'two', users: [{ id: 'U2', name: 'Grace' }] }],
            },
          },
        ],
      },
    ],
  };
}
function fixtureTarget(data: ReturnType<typeof fixture>, index: number) {
  const target = data.analyses[0]?.targets[index];
  if (!target) throw new Error(`Missing fixture target ${index}`);
  return target;
}
function fixtureChannel(target: ReturnType<typeof fixtureTarget>, index = 0) {
  const channel = target.analysisConfig.channels[index];
  if (!channel) throw new Error(`Missing fixture channel ${index}`);
  return channel;
}
async function setup(data = fixture()) {
  const dir = await mkdtemp(path.join(tmpdir(), 'portfolio-resource-'));
  dirs.push(dir);
  const manifest = path.join(dir, 'portfolio.json');
  await writeFile(manifest, `${JSON.stringify(data, null, 2)}\n`);
  return { dir, manifest };
}
async function run(
  manifest: string,
  action: 'list' | 'add' | 'remove' | 'move',
  values: Record<string, unknown> = {},
) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await runPortfolioResource({ manifest, action, 'dry-run': false, ...values });
  return JSON.parse(String(log.mock.lastCall?.[0]));
}

describe('portfolio-resource command', () => {
  it('lists complete target resources', async () => {
    const { manifest } = await setup();
    const result = await run(manifest, 'list');
    expect(result.detail.targets[0].channels[0].users[0]).toEqual({
      id: 'U1',
      name: 'Ada',
      role: 'lead',
    });
  });
  it('adds by name, reuses role, writes valid JSON, and creates a backup', async () => {
    const { dir, manifest } = await setup();
    const result = await run(manifest, 'add', { target: 'b', user: 'ada', channel: 'C2' });
    expect(result.detail.user.role).toBe('lead');
    expect(result.backupPath).toMatch(/\.bak$/);
    expect((await readdir(dir)).some((name) => name.endsWith('.bak'))).toBe(true);
    expect(
      JSON.parse(await readFile(manifest, 'utf8')).analyses[0].targets[1].analysisConfig.channels[0]
        .users,
    ).toHaveLength(2);
  });
  it('rejects duplicate adds', async () => {
    const { manifest } = await setup();
    await expect(run(manifest, 'add', { target: 'a', user: 'U1', channel: 'C1' })).rejects.toThrow(
      'already on channel',
    );
  });
  it('removes from every channel by default and can narrow by channel', async () => {
    const first = await setup();
    await run(first.manifest, 'remove', { target: 'a', user: 'U1' });
    expect(JSON.stringify(JSON.parse(await readFile(first.manifest, 'utf8')))).not.toContain('U1');
    const second = await setup();
    await run(second.manifest, 'remove', { target: 'a', user: 'U1', channel: 'C1' });
    const raw = JSON.parse(await readFile(second.manifest, 'utf8'));
    expect(raw.analyses[0].targets[0].analysisConfig.channels[1].users[0].id).toBe('U1');
  });
  it('moves without duplicates and rejects unknown users', async () => {
    const { manifest } = await setup();
    await run(manifest, 'move', { from: 'a', to: 'b', user: 'Ada' });
    const raw = JSON.parse(await readFile(manifest, 'utf8'));
    expect(JSON.stringify(raw.analyses[0].targets[0])).not.toContain('U1');
    expect(
      raw.analyses[0].targets[1].analysisConfig.channels[0].users.filter(
        (u: { id: string }) => u.id === 'U1',
      ),
    ).toHaveLength(1);
    await expect(run(manifest, 'move', { from: 'a', to: 'b', user: 'Nobody' })).rejects.toThrow(
      'Unknown user',
    );
  });
  it('pauses an active target after removing its last member', async () => {
    const data = fixture();
    fixtureTarget(data, 0).analysisConfig.channels.splice(1);
    const { manifest } = await setup(data);
    const result = await run(manifest, 'remove', { target: 'a', user: 'U1' });
    expect(result.detail.statusChanges).toEqual([{ targetId: 'a', from: 'active', to: 'paused' }]);
    expect(JSON.parse(await readFile(manifest, 'utf8')).analyses[0].targets[0].status).toBe(
      'paused',
    );
  });
  it('activates a paused target when adding its first member', async () => {
    const data = fixture();
    const destination = fixtureTarget(data, 1);
    destination.status = 'paused';
    fixtureChannel(destination).users = [];
    const { manifest } = await setup(data);
    const result = await run(manifest, 'add', { target: 'b', user: 'U1', channel: 'C2' });
    expect(result.detail.statusChanges).toEqual([{ targetId: 'b', from: 'paused', to: 'active' }]);
  });
  it('never changes an archived target status', async () => {
    const data = fixture();
    const destination = fixtureTarget(data, 1);
    destination.status = 'archived';
    Object.assign(destination, { endedOn: '2026-09-23' });
    fixtureChannel(destination).users = [];
    const { manifest } = await setup(data);
    const result = await run(manifest, 'add', { target: 'b', user: 'U1', channel: 'C2' });
    expect(result.detail.statusChanges).toEqual([]);
    expect(JSON.parse(await readFile(manifest, 'utf8')).analyses[0].targets[1].status).toBe(
      'archived',
    );
  });
  it('leaves status unchanged with --no-auto-status', async () => {
    const data = fixture();
    fixtureTarget(data, 0).analysisConfig.channels.splice(1);
    const { manifest } = await setup(data);
    const result = await run(manifest, 'remove', {
      target: 'a',
      user: 'U1',
      'auto-status': false,
    });
    expect(result.detail.statusChanges).toEqual([]);
    expect(JSON.parse(await readFile(manifest, 'utf8')).analyses[0].targets[0].status).toBe(
      'active',
    );
  });
  it('reports both source and destination status transitions for a move', async () => {
    const data = fixture();
    fixtureTarget(data, 0).analysisConfig.channels.splice(1);
    const destination = fixtureTarget(data, 1);
    destination.status = 'paused';
    fixtureChannel(destination).users = [];
    const { manifest } = await setup(data);
    const result = await run(manifest, 'move', { from: 'a', to: 'b', user: 'U1' });
    expect(result.detail.statusChanges).toEqual([
      { targetId: 'a', from: 'active', to: 'paused' },
      { targetId: 'b', from: 'paused', to: 'active' },
    ]);
  });
  it('dry-runs without writing', async () => {
    const { manifest } = await setup();
    const before = await readFile(manifest, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runPortfolioResource({
      manifest,
      action: 'add',
      target: 'b',
      user: 'U1',
      channel: 'C2',
      'dry-run': true,
    });
    const result = JSON.parse(String(log.mock.lastCall?.[0]));
    expect(result).toMatchObject({
      changed: true,
      dryRun: true,
      backupPath: null,
      detail: { user: { id: 'U1', role: 'lead' } },
    });
    expect(await readFile(manifest, 'utf8')).toBe(before);
  });
  it('rejects invalid manifests before writing', async () => {
    const { manifest } = await setup();
    await writeFile(manifest, '{}\n');
    await expect(run(manifest, 'list')).rejects.toThrow('Invalid portfolio manifest');
  });
});
