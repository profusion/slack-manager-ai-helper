import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPortfolioManifest,
  materializeAnalysisConfig,
  materializeRunAndNotifyConfig,
  type PortfolioManifest,
  validateRawPortfolioManifest,
} from '../src/portfolio/load-portfolio.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('portfolio manifests', () => {
  it('loads the sanitized plan reviews portfolio example', async () => {
    const loaded = await loadPortfolioManifest('examples/portfolio-plan-reviews.json');

    expect(loaded.manifestHash).toHaveLength(64);
    expect(loaded.manifest.analyses.map((analysis) => analysis.id)).toEqual(['plan-reviews']);
    expect(loaded.manifest.analyses[0]?.targets.map((target) => target.id)).toEqual([
      'project-alpha',
      'project-beta',
      'product-web',
      'product-api',
      'legacy-project',
    ]);
  });

  it('materializes analysis configs through deterministic deep merge', async () => {
    const { manifest } = await loadPortfolioManifest('examples/portfolio-plan-reviews.json');

    const config = materializeAnalysisConfig({
      manifest,
      analysisId: 'plan-reviews',
      targetId: 'project-beta',
      runId: 'workday',
    });

    expect(config.prompts).toEqual([
      '@DEFAULT_BASE_INSTRUCTIONS@',
      '@DEFAULT_BASE_PROMPT@',
      'plan-reviews/INSTRUCTIONS.md',
    ]);
    expect(config.model.model).toBe('gpt-5.4-mini');
    expect(config.context?.syntheticThreads?.candidateWindowMinutes).toBe(90);
    expect(config.context?.syntheticThreads?.classifier?.model).toBe('qwen3:0.6b');
    expect(config.channels?.map((channel) => channel.id)).toEqual(['C_PROJECT_BETA']);
  });

  it('replaces arrays while recursively merging notification objects', async () => {
    const { manifest } = await loadPortfolioManifest('examples/portfolio-plan-reviews.json');

    const config = materializeRunAndNotifyConfig({
      manifest,
      analysisId: 'plan-reviews',
      targetId: 'project-beta',
      runId: 'workday',
    });

    expect(config).toMatchObject({
      locale: 'pt-BR',
      transports: {
        smtp: {
          host: 'smtp.example.com',
          auth: {
            user: 'manager@example.com',
            passEnvVar: 'SMTP_PASS',
          },
          to: ['manager+project-beta@example.com', 'lead+project-beta@example.com'],
        },
        slack: {
          enabled: true,
          tokenEnvVar: 'SLACK_BOT_TOKEN',
          defaultChannel: '#project-beta-reports',
        },
      },
    });
  });

  it('infers notification name from target name when omitted', () => {
    const manifest: PortfolioManifest = {
      schemaVersion: 1,
      defaults: {
        runAndNotifyConfig: {
          locale: 'pt-BR',
        },
      },
      analyses: [
        {
          id: 'analysis',
          name: 'Analysis',
          targets: [
            {
              id: 'target',
              name: 'Target Display Name',
              status: 'active',
              runAndNotifyConfig: {},
            },
          ],
        },
      ],
    };

    expect(
      materializeRunAndNotifyConfig({
        manifest,
        analysisId: 'analysis',
        targetId: 'target',
      }),
    ).toMatchObject({
      locale: 'pt-BR',
      name: 'Target Display Name',
    });
  });

  it('prepends and appends common matchers to channel matchers', () => {
    const manifest: PortfolioManifest = {
      schemaVersion: 1,
      defaults: {
        analysisConfig: {
          workspaceUrl: 'https://example.slack.com',
          prompts: ['base.md'],
          model: {
            provider: 'openai',
            model: 'base-model',
          },
        },
        matchers: {
          pre: [{ id: 'pre', type: 'regex', pattern: '^pre' }],
          post: [
            {
              id: 'post',
              type: 'exclude',
              matcher: { id: 'laughs', type: 'regex', pattern: 'kk' },
            },
          ],
        },
      },
      analyses: [
        {
          id: 'analysis',
          name: 'Analysis',
          defaults: {
            matchers: {
              post: [{ id: 'analysis-post', type: 'regex', pattern: 'done' }],
            },
          },
          targets: [
            {
              id: 'target',
              name: 'Target',
              status: 'active',
              analysisConfig: {
                channels: [
                  {
                    id: 'C_TARGET',
                    matchers: [{ id: 'local', type: 'regex', pattern: 'plan' }],
                  },
                  {
                    id: 'C_EMPTY',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const config = materializeAnalysisConfig({
      manifest,
      analysisId: 'analysis',
      targetId: 'target',
    });

    expect(config.channels).toBeDefined();
    const channels = config.channels ?? [];

    expect(channels[0]?.matchers?.map((matcher) => matcher.id)).toEqual([
      'pre',
      'local',
      'post',
      'analysis-post',
    ]);
    expect(channels[1]?.matchers?.map((matcher) => matcher.id)).toEqual([
      'pre',
      'post',
      'analysis-post',
    ]);
  });

  it('expands alsoChannels after applying common matchers', () => {
    const manifest: PortfolioManifest = {
      schemaVersion: 1,
      defaults: {
        analysisConfig: {
          workspaceUrl: 'https://example.slack.com',
          prompts: ['base.md'],
          model: {
            provider: 'openai',
            model: 'base-model',
          },
        },
        matchers: {
          post: [
            {
              id: 'exclude_laughs',
              type: 'exclude',
              matcher: { id: 'laughs', type: 'regex', pattern: 'kk' },
            },
          ],
        },
      },
      analyses: [
        {
          id: 'analysis',
          name: 'Analysis',
          targets: [
            {
              id: 'target',
              name: 'Target',
              status: 'active',
              analysisConfig: {
                channels: [
                  {
                    id: 'C_PRIMARY',
                    name: 'primary',
                    alsoChannels: [{ id: 'C_ALSO', name: 'also' }],
                    users: [{ id: 'U1', name: 'Alice', role: 'engineer' }],
                    matchers: [{ id: 'local', type: 'regex', pattern: 'plan' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const config = materializeAnalysisConfig({
      manifest,
      analysisId: 'analysis',
      targetId: 'target',
    });

    expect(config.channels?.map((channel) => channel.id)).toEqual(['C_PRIMARY', 'C_ALSO']);
    expect(config.channels?.[0]?.users).toEqual([{ id: 'U1', name: 'Alice', role: 'engineer' }]);
    expect(config.channels?.[1]?.users).toEqual([{ id: 'U1', name: 'Alice', role: 'engineer' }]);
    expect(config.channels?.[0]?.matchers?.map((matcher) => matcher.id)).toEqual([
      'local',
      'exclude_laughs',
    ]);
    expect(config.channels?.[1]?.matchers?.map((matcher) => matcher.id)).toEqual([
      'local',
      'exclude_laughs',
    ]);
    expect(config.channels?.[0]).not.toHaveProperty('alsoChannels');
    expect(config.channels?.[1]).not.toHaveProperty('alsoChannels');
  });

  it('supports target-specific run overrides', () => {
    const manifest: PortfolioManifest = {
      schemaVersion: 1,
      defaults: {
        analysisConfig: {
          workspaceUrl: 'https://example.slack.com',
          prompts: ['base.md'],
          model: {
            provider: 'openai',
            model: 'base-model',
          },
        },
      },
      analyses: [
        {
          id: 'analysis',
          name: 'Analysis',
          runs: [
            {
              id: 'morning',
              schedule: { kind: 'daily' },
              window: { date: 'today' },
              analysisConfig: {
                context: {
                  maxMessages: 10,
                },
              },
            },
          ],
          targets: [
            {
              id: 'target',
              name: 'Target',
              status: 'active',
              analysisConfig: {
                channels: [{ id: 'C_TARGET' }],
              },
              runs: [
                {
                  runId: 'morning',
                  analysisConfig: {
                    model: {
                      model: 'target-model',
                    },
                    context: {
                      nearbyMessagesAfterMinutes: 15,
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const config = materializeAnalysisConfig({
      manifest,
      analysisId: 'analysis',
      targetId: 'target',
      runId: 'morning',
    });

    expect(config).toMatchObject({
      prompts: ['base.md'],
      model: {
        provider: 'openai',
        model: 'target-model',
      },
      channels: [{ id: 'C_TARGET' }],
      context: {
        maxMessages: 10,
        nearbyMessagesAfterMinutes: 15,
      },
    });
  });

  it('rejects archived targets without endedOn', () => {
    expect(() =>
      validateRawPortfolioManifest(
        {
          schemaVersion: 1,
          analyses: [
            {
              id: 'analysis',
              name: 'Analysis',
              targets: [
                {
                  id: 'target',
                  name: 'Target',
                  status: 'archived',
                },
              ],
            },
          ],
        },
        'portfolio.json',
      ),
    ).toThrow('archived target analysis/target requires endedOn');
  });

  it('rejects run-and-notify stdout and stderr parsing in portfolio manifests', () => {
    expect(() =>
      validateRawPortfolioManifest(
        {
          schemaVersion: 1,
          defaults: {
            runAndNotifyConfig: {
              stdout: {
                format: 'markdown',
              },
            },
          },
          analyses: [
            {
              id: 'analysis',
              name: 'Analysis',
              targets: [
                {
                  id: 'target',
                  name: 'Target',
                  status: 'active',
                },
              ],
            },
          ],
        },
        'portfolio.json',
      ),
    ).toThrow('Invalid portfolio manifest');
  });

  it('loads a manifest from disk and reports duplicate ids', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-portfolio-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          analyses: [
            {
              id: 'analysis',
              name: 'Analysis',
              targets: [
                {
                  id: 'target',
                  name: 'Target',
                  status: 'active',
                },
                {
                  id: 'target',
                  name: 'Duplicate Target',
                  status: 'active',
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(loadPortfolioManifest(manifestPath)).rejects.toThrow(
      'duplicate analysis analysis target id target',
    );
  });
});
