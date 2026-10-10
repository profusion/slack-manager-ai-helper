import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coachPortfolioAnalysis, userReviewExcerpts } from '../src/portfolio/coach-portfolio.js';
import type { PortfolioManifest } from '../src/portfolio/load-portfolio.js';
import { defaultCommandRunner, notifyCoachDm } from '../src/portfolio/notify-portfolio.js';
import { planPortfolioDryRun } from '../src/portfolio/plan-portfolio.js';
import { createRun, finishRun, openStateStore, saveModelOutput } from '../src/state/state-store.js';
import type { ResolvedConfig } from '../src/types.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('notifyCoachDm', () => {
  beforeEach(() => {
    const tokenEnvVar = 'TEST_COACH_TOKEN';
    process.env[tokenEnvVar] = 'test-token';
  });
  afterEach(() => {
    const tokenEnvVar = 'TEST_COACH_TOKEN';
    delete process.env[tokenEnvVar];
  });
  const notification = {
    dryRun: true,
    name: 'Manager report',
    templatesDir: '/private/templates',
    transports: {
      smtp: { enabled: true, to: ['manager@example.com'] },
      slack: {
        enabled: true,
        tokenEnvVar: 'TEST_COACH_TOKEN',
        targets: ['C_MANAGER'],
        defaultChannel: 'C_OLD',
        thread: true,
      },
    },
  };

  it('passes private Markdown to one Slack user with isolated dry-run config', async () => {
    const text = '**Bold** and [a link](https://example.com)';
    let messagePath = '';
    let args: readonly string[] = [];
    const status = await notifyCoachDm({
      userId: 'U12345678',
      text,
      notification,
      command: 'run-and-notify-test',
      commandRunner: async (command, receivedArgs) => {
        expect(command).toBe('run-and-notify-test');
        args = receivedArgs;
        messagePath = receivedArgs.at(-1) ?? '';
        expect(await readFile(messagePath, 'utf8')).toBe(text);
        expect((await stat(messagePath)).mode & 0o777).toBe(0o600);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(status).toBe('skipped');
    expect(args).toEqual([
      '--name=Personal plan coaching',
      '--dry-run=true',
      '--hide-command-if-success=true',
      '--stdout.format=markdown',
      '--transports.slack.enabled=true',
      '--transports.slack.token-env-var=TEST_COACH_TOKEN',
      '--transports.slack.targets=U12345678',
      '--transports.slack.thread=true',
      '--transports.slack.unfurl-links=false',
      '--transports.slack.unfurl-media=false',
      '--',
      'cat',
      messagePath,
    ]);
    expect(args.join(' ')).not.toContain(text);
    await expect(stat(messagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports command failures and cleans up the private file', async () => {
    let messagePath = '';
    await expect(
      notifyCoachDm({
        userId: 'W12345678',
        text: 'Actionable coaching',
        notification,
        commandRunner: async (_command, args) => {
          messagePath = args.at(-1) ?? '';
          return { exitCode: 2, stdout: '', stderr: 'Slack unavailable' };
        },
      }),
    ).rejects.toThrow('Coach DM notification failed: Slack unavailable');
    await expect(stat(messagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs the installed notifier in dry-run mode with only the intended Slack recipient', async () => {
    let output = '';
    await notifyCoachDm({
      userId: 'U12345678',
      text: '# Private coaching\n\n- Plan a concrete next step',
      notification,
      commandRunner: async (command, args) => {
        const result = await defaultCommandRunner(command, args);
        output = `${result.stdout}\n${result.stderr}`;
        return result;
      },
    });
    expect(output).toContain('U12345678');
    expect(output).not.toContain('C_MANAGER');
    expect(output).not.toContain('manager@example.com');
  });

  it('rejects overlong Markdown before invoking a notification command', async () => {
    let invoked = false;
    await expect(
      notifyCoachDm({
        userId: 'U12345678',
        text: 'x'.repeat(12_001),
        notification,
        commandRunner: async () => {
          invoked = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow('Coach DM exceeds 12000 characters');
    expect(invoked).toBe(false);
  });
});

describe('portfolio plan coaching', () => {
  it('skips matched excerpts before generation and sends nothing for model abstention', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'portfolio-coach-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'daily.md'), 'Daily instructions.', 'utf8');
    await writeFile(path.join(dir, 'coach.md'), 'Write useful coaching or abstain.', 'utf8');
    const manifest: PortfolioManifest = {
      schemaVersion: 1,
      coach: {
        enabled: true,
        prompt: 'coach.md',
        model: { provider: 'openai', model: 'coach-test' },
        skipWhenReportMatches: 'Planning quality:.*strong',
      },
      defaults: {
        analysisConfig: {
          workspaceUrl: 'https://example.slack.com',
          prompts: ['daily.md'],
          model: { provider: 'openai', model: 'review-test' },
          channels: [{ id: 'C1' }],
        },
        runAndNotifyConfig: {
          transports: { slack: { enabled: true, tokenEnvVar: 'TEST_COACH_TOKEN' } },
        },
      },
      analyses: [
        {
          id: 'plans',
          name: 'Plans',
          runs: [{ id: 'daily', schedule: { kind: 'daily' }, window: { date: 'today' } }],
          targets: [
            {
              id: 'project',
              name: 'Project',
              status: 'active',
              coach: { enabled: null, skipWhenReportMatches: null },
            },
          ],
        },
      ],
    };
    const task = planPortfolioDryRun({
      manifest,
      manifestPath: path.join(dir, 'portfolio.json'),
      manifestHash: 'hash',
      now: new Date('2026-10-09T12:00:00Z'),
    }).tasks.find((item) => item.type === 'analysis');
    if (task?.type !== 'analysis') throw new Error('Expected analysis task');
    const statePath = path.join(dir, 'state.json');
    const resolved: ResolvedConfig = {
      topicId: 'plans-project',
      configHash: 'hash',
      configPath: path.join(dir, 'portfolio.json'),
      config: {
        workspaceUrl: 'https://example.slack.com',
        prompts: [path.join(dir, 'daily.md')],
        model: { provider: 'openai', model: 'review-test' },
        storage: { statePath, slacrawlDatabasePath: path.join(dir, 'slacrawl.sqlite') },
        channels: [
          {
            id: 'C1',
            users: [
              { id: 'U_A', name: 'Alex', role: 'engineer' },
              { id: 'U_B', name: 'Bob', role: 'engineer' },
            ],
          },
        ],
        context: {},
      },
    };
    createRun(openStateStore(statePath, resolved.topicId), {
      id: 'run-1',
      topicId: resolved.topicId,
      configHash: 'hash',
      startedAt: '2026-10-09T12:00:00Z',
      window: { executionMode: 'explicit', scanStartCursor: null, scanEndCursor: null },
    });
    const modelInputs: string[] = [];
    const sent: string[] = [];
    const tokenEnvVar = 'TEST_COACH_TOKEN';
    process.env[tokenEnvVar] = 'test-token';
    try {
      const first = await coachPortfolioAnalysis({
        manifest,
        manifestPath: path.join(dir, 'portfolio.json'),
        task,
        resolved,
        runId: 'run-1',
        notify: true,
        reportText:
          '# Date: 2026-10-09\n## User: Alex (engineer) [U_A]\n- Planning quality: ✅ strong\n## User: Bob (engineer) [U_B]\n- Planning quality: weak',
        generateText: async ({ prompt }) => {
          modelInputs.push(prompt);
          return { text: ' NO_COACHING_NEEDED\n' };
        },
        commandRunner: async (_command, args) => {
          sent.push(
            args.find((arg) => arg.startsWith('--transports.slack.targets='))?.split('=')[1] ?? '',
          );
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      expect(first).toEqual([
        { date: '2026-10-09', userId: 'U_A', status: 'skipped', reason: 'report_match' },
        { date: '2026-10-09', userId: 'U_B', status: 'skipped', reason: 'no_coaching_needed' },
      ]);
      expect(modelInputs).toHaveLength(1);
      expect(modelInputs[0]).toContain('Bob (engineer)');
      expect(modelInputs[0]).not.toContain('Alex (engineer)');
      expect(sent).toEqual([]);
      expect(openStateStore(statePath, resolved.topicId).state.runs[0]?.coaching).toBeUndefined();

      const analysis = manifest.analyses[0];
      const target = analysis?.targets[0];
      if (!analysis || !target) throw new Error('Expected coaching target');
      const overrideManifest: PortfolioManifest = {
        ...manifest,
        analyses: [
          {
            ...analysis,
            targets: [
              {
                ...target,
                coach: { skipWhenReportMatches: 'Plan submitted:.*no' },
              },
            ],
          },
        ],
      };
      const second = await coachPortfolioAnalysis({
        manifest: overrideManifest,
        manifestPath: path.join(dir, 'portfolio.json'),
        task,
        resolved,
        runId: 'run-1',
        notify: true,
        reportText:
          '# Date: 2026-10-10\n## User: Alex (engineer) [U_A]\n- Planning quality: ✅ strong\n## User: Bob (engineer) [U_B]\n- Plan submitted: ❌ no',
        generateText: async ({ prompt }) => {
          modelInputs.push(prompt);
          return { text: 'A useful concrete suggestion' };
        },
        commandRunner: async (_command, args) => {
          sent.push(
            args.find((arg) => arg.startsWith('--transports.slack.targets='))?.split('=')[1] ?? '',
          );
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      expect(second).toEqual([
        { date: '2026-10-10', userId: 'U_A', status: 'delivered' },
        { date: '2026-10-10', userId: 'U_B', status: 'skipped', reason: 'report_match' },
      ]);
      expect(modelInputs).toHaveLength(2);
      expect(modelInputs[1]).toContain('Alex (engineer)');
      expect(sent).toEqual(['U_A']);
      expect(openStateStore(statePath, resolved.topicId).state.runs[0]?.coaching).toMatchObject([
        { date: '2026-10-10', userId: 'U_A', text: 'A useful concrete suggestion' },
      ]);

      const optOutManifest: PortfolioManifest = {
        ...overrideManifest,
        analyses: [
          {
            ...analysis,
            targets: [{ ...target, coach: { skipWhenReportMatches: false } }],
          },
        ],
      };
      const third = await coachPortfolioAnalysis({
        manifest: optOutManifest,
        manifestPath: path.join(dir, 'portfolio.json'),
        task,
        resolved,
        runId: 'run-1',
        notify: true,
        reportText:
          '# Date: 2026-10-11\n## User: Alex (engineer) [U_A]\n- Planning quality: ✅ strong\n## User: Bob (engineer) [U_B]\n- Planning quality: weak',
        generateText: async ({ prompt }) => {
          modelInputs.push(prompt);
          return { text: 'A useful concrete suggestion' };
        },
        commandRunner: async (_command, args) => {
          sent.push(
            args.find((arg) => arg.startsWith('--transports.slack.targets='))?.split('=')[1] ?? '',
          );
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      expect(third).toEqual([
        { date: '2026-10-11', userId: 'U_A', status: 'delivered' },
        { date: '2026-10-11', userId: 'U_B', status: 'delivered' },
      ]);
      expect(modelInputs).toHaveLength(4);
      expect(sent).toEqual(['U_A', 'U_A', 'U_B']);

      const dryRunManifest: PortfolioManifest = {
        ...manifest,
        defaults: {
          ...manifest.defaults,
          runAndNotifyConfig: {
            ...manifest.defaults?.runAndNotifyConfig,
            dryRun: true,
          },
        },
      };
      const dryRunDelivery = await coachPortfolioAnalysis({
        manifest: dryRunManifest,
        manifestPath: path.join(dir, 'portfolio.json'),
        task,
        resolved,
        runId: 'run-1',
        notify: true,
        reportText:
          '# Date: 2026-10-12\n## User: Alex (engineer) [U_A]\n- Plan needs detail\n## User: Bob (engineer) [U_B]\n- Plan needs detail',
        generateText: async () => ({ text: 'Dry-run suggestion' }),
        commandRunner: async (_command, args) => {
          expect(args).toContain('--dry-run=true');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      expect(dryRunDelivery).toEqual([
        { date: '2026-10-12', userId: 'U_A', status: 'skipped' },
        { date: '2026-10-12', userId: 'U_B', status: 'skipped' },
      ]);
      expect(
        openStateStore(statePath, resolved.topicId).state.runs[0]?.coaching?.filter(
          (item) => item.date === '2026-10-12',
        ),
      ).toMatchObject([{ delivery: 'skipped' }, { delivery: 'skipped' }]);
    } finally {
      delete process.env[tokenEnvVar];
    }
  });

  it('matches only the configured user and date excerpts', () => {
    const report =
      '# Date: 2026-10-08 (thursday)\n## User: Alex (engineer) [U_A]\n- First plan\n## User: Alex (engineer) [U_B]\n- Other plan\n# Date: 2026-10-09 (friday)\n## User: Alex (engineer) [U_A]\n- Second plan\n# Team Summary\nSummary';
    expect(userReviewExcerpts(report, [{ id: 'U_A', name: 'Alex', role: 'engineer' }])).toEqual([
      {
        date: '2026-10-08',
        userId: 'U_A',
        markdown: '## User: Alex (engineer) [U_A]\n- First plan',
      },
      {
        date: '2026-10-09',
        userId: 'U_A',
        markdown: '## User: Alex (engineer) [U_A]\n- Second plan',
      },
    ]);
  });

  it('rejects a conflicting Slack id on another user heading', () => {
    const report =
      '# Date: 2026-10-09 (friday)\n## User: Bob (engineer) [U_A]\n- Private Bob review';
    expect(
      userReviewExcerpts(report, [
        { id: 'U_A', name: 'Alex', role: 'engineer' },
        { id: 'U_B', name: 'Bob', role: 'engineer' },
      ]),
    ).toEqual([]);
  });

  it('requires an explicit Slack id even when the name is unique', () => {
    expect(
      userReviewExcerpts('# Date: 2026-10-09\n## User: Alex (engineer)\n- Plan', [
        { id: 'U_A', name: 'Alex', role: 'engineer' },
      ]),
    ).toEqual([]);
  });

  it('joins repeated sections for one user and date into one coach input', () => {
    const report =
      '# Date: 2026-10-09 (friday)\n## User: Alex (engineer) [U_A]\n- First plan\n#### Segment two\n## User: Alex (engineer) [U_A]\n- Second plan';
    expect(userReviewExcerpts(report, [{ id: 'U_A', name: 'Alex', role: 'engineer' }])).toEqual([
      {
        date: '2026-10-09',
        userId: 'U_A',
        markdown:
          '## User: Alex (engineer) [U_A]\n- First plan\n#### Segment two\n\n## User: Alex (engineer) [U_A]\n- Second plan',
      },
    ]);
  });

  it('stores one message per day without sending when notifications are disabled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'portfolio-coach-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'daily.md'), 'Daily instructions.', 'utf8');
    await writeFile(path.join(dir, 'coach.md'), 'Write a friendly coaching DM.', 'utf8');
    const manifest: PortfolioManifest = {
      schemaVersion: 1,
      defaults: {
        analysisConfig: {
          workspaceUrl: 'https://example.slack.com',
          prompts: ['daily.md'],
          model: { provider: 'openai', model: 'review-test' },
          channels: [{ id: 'C1' }],
        },
        runAndNotifyConfig: {
          transports: { slack: { enabled: true, tokenEnvVar: 'TEST_COACH_TOKEN', thread: true } },
        },
      },
      coach: {
        enabled: false,
        prompt: 'coach.md',
        model: { provider: 'openai', model: 'cheap-test' },
      },
      analyses: [
        {
          id: 'plans',
          name: 'Plans',
          runs: [{ id: 'daily', schedule: { kind: 'daily' }, window: { date: 'today' } }],
          targets: [{ id: 'project', name: 'Project', status: 'active', coach: null }],
        },
      ],
    };
    const task = planPortfolioDryRun({
      manifest,
      manifestPath: path.join(dir, 'portfolio.json'),
      manifestHash: 'hash',
      now: new Date('2026-10-09T12:00:00Z'),
    }).tasks.find((item) => item.type === 'analysis');
    if (task?.type !== 'analysis') throw new Error('Expected analysis task');
    const statePath = path.join(dir, 'state.json');
    const resolved: ResolvedConfig = {
      topicId: 'plans-project',
      configHash: 'hash',
      configPath: path.join(dir, 'portfolio.json'),
      config: {
        workspaceUrl: 'https://example.slack.com',
        prompts: [path.join(dir, 'daily.md')],
        model: { provider: 'openai', model: 'review-test' },
        storage: { statePath, slacrawlDatabasePath: path.join(dir, 'slacrawl.sqlite') },
        channels: [
          {
            id: 'C1',
            users: [
              { id: 'U_A', name: 'Alex', role: 'engineer', coach: true },
              { id: 'U_B', name: 'Bob', role: 'engineer', coach: false },
            ],
          },
        ],
        context: {},
      },
    };
    let store = createRun(openStateStore(statePath, resolved.topicId), {
      id: 'run-1',
      topicId: resolved.topicId,
      configHash: 'hash',
      startedAt: '2026-10-09T12:00:00Z',
      window: { executionMode: 'explicit', scanStartCursor: null, scanEndCursor: null },
    });
    store = saveModelOutput(store, {
      id: 'out-1',
      runId: 'run-1',
      topicId: resolved.topicId,
      outputText: 'review',
      reportText: 'report',
      outputJson: {
        segments: [
          {
            content: JSON.stringify({
              users: [
                { user: { id: 'U_A' }, planning_patterns: [{ description: 'Vague deliverables' }] },
              ],
            }),
          },
          {
            content: JSON.stringify({
              users: [
                { user: { id: 'U_A' }, positive_patterns: [{ description: 'Helpful review' }] },
              ],
            }),
          },
        ],
      },
      createdAt: '2026-10-09T12:00:00Z',
    });
    finishRun(store, {
      id: 'run-1',
      finishedAt: '2026-10-09T12:00:01Z',
      status: 'completed',
      inputMessageCount: 1,
      matchedMessageCount: 1,
      evidenceMessageCount: 1,
      modelCalled: true,
    });
    const modelInputs: string[] = [];
    const result = await coachPortfolioAnalysis({
      manifest,
      manifestPath: path.join(dir, 'portfolio.json'),
      task,
      resolved,
      runId: 'run-1',
      notify: false,
      reportText:
        '# Date: 2026-10-08 (thursday)\n## User: Alex (engineer) [U_A]\n- Plan one\n## User: Bob (engineer) [U_B]\n- Bob plan\n# Date: 2026-10-09 (friday)\n## User: Alex (engineer) [U_A]\n- Plan two',
      generateText: async ({ prompt }) => {
        modelInputs.push(prompt);
        return { text: `Coach ${modelInputs.length}` };
      },
      commandRunner: async () => {
        throw new Error('DM must not be sent');
      },
    });
    expect(result).toEqual([
      { date: '2026-10-08', userId: 'U_A', status: 'skipped' },
      { date: '2026-10-09', userId: 'U_A', status: 'skipped' },
    ]);
    expect(modelInputs).toHaveLength(2);
    expect(modelInputs[0]).toContain('Vague deliverables');
    expect(modelInputs[0]).toContain('Helpful review');
    expect(modelInputs[0]).not.toContain('Bob plan');
    expect(openStateStore(statePath, resolved.topicId).state.runs[0]?.coaching).toMatchObject([
      { date: '2026-10-08', userId: 'U_A', text: 'Coach 1', delivery: 'skipped' },
      { date: '2026-10-09', userId: 'U_A', text: 'Coach 2', delivery: 'skipped' },
    ]);

    const attempts: string[] = [];
    const fallbackManifest: PortfolioManifest = {
      ...manifest,
      coach: {
        enabled: true,
        prompt: 'coach.md',
        model: {
          provider: 'openai',
          model: 'primary',
          retries: 1,
          fallback: { provider: 'openai', model: 'fallback', retries: 0 },
        },
      },
    };
    await coachPortfolioAnalysis({
      manifest: fallbackManifest,
      manifestPath: path.join(dir, 'portfolio.json'),
      task,
      resolved,
      runId: 'run-1',
      notify: false,
      reportText: '# Date: 2026-10-08\n## User: Alex (engineer) [U_A]\n- Plan one',
      generateText: async ({ config }) => {
        attempts.push(config.model.model);
        if (config.model.model === 'primary') throw new Error('Primary unavailable');
        return { text: 'Fallback coach' };
      },
    });
    expect(attempts).toEqual(['primary', 'primary', 'fallback']);
    expect(
      openStateStore(statePath, resolved.topicId).state.runs[0]?.coaching?.find(
        (item) => item.date === '2026-10-08',
      ),
    ).toMatchObject({ text: 'Fallback coach', modelName: 'fallback' });

    const tokenEnvVar = 'TEST_COACH_TOKEN';
    process.env[tokenEnvVar] = 'test-token';
    try {
      const pending: string[] = [];
      const delivery = await coachPortfolioAnalysis({
        manifest,
        manifestPath: path.join(dir, 'portfolio.json'),
        task,
        resolved,
        runId: 'run-1',
        notify: true,
        reportText: '# Date: 2026-10-08 (thursday)\n## User: Alex (engineer) [U_A]\n- Plan one',
        generateText: async () => ({ text: 'Private coach' }),
        commandRunner: async (_command, args) => {
          expect(args).toContain('--transports.slack.thread=true');
          const record = openStateStore(statePath, resolved.topicId).state.runs[0]?.coaching?.find(
            (item) => item.userId === 'U_A' && item.date === '2026-10-08',
          );
          pending.push(record?.delivery ?? 'missing');
          return { exitCode: 1, stdout: '', stderr: 'Slack unavailable' };
        },
      });
      expect(pending).toEqual(['pending']);
      expect(delivery).toMatchObject([
        {
          date: '2026-10-08',
          userId: 'U_A',
          status: 'failed',
          error: 'Coach DM notification failed: Slack unavailable',
        },
      ]);
      expect(
        openStateStore(statePath, resolved.topicId).state.runs[0]?.coaching?.find(
          (item) => item.date === '2026-10-08',
        ),
      ).toMatchObject({
        delivery: 'failed',
        deliveryError: 'Coach DM notification failed: Slack unavailable',
      });

      const backupPath = `${statePath}.pending`;
      const delivered = await coachPortfolioAnalysis({
        manifest,
        manifestPath: path.join(dir, 'portfolio.json'),
        task,
        resolved,
        runId: 'run-1',
        notify: true,
        reportText: '# Date: 2026-10-09\n## User: Alex (engineer) [U_A]\n- Plan two',
        generateText: async () => ({ text: 'Delivered coach' }),
        commandRunner: async () => {
          await rename(statePath, backupPath);
          await mkdir(statePath);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      expect(delivered[0]).toMatchObject({ status: 'delivered', userId: 'U_A' });
      expect(delivered[0]?.persistenceError).toBeTruthy();
      await rm(statePath, { recursive: true });
      await rename(backupPath, statePath);
      expect(
        openStateStore(statePath, resolved.topicId).state.runs[0]?.coaching?.find(
          (item) => item.date === '2026-10-09',
        ),
      ).toMatchObject({ delivery: 'pending', text: 'Delivered coach' });
    } finally {
      delete process.env[tokenEnvVar];
    }
  });
});
