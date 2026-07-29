import type { CommandModule } from 'yargs';
import { executePortfolioAnalyses } from '../portfolio/execute-portfolio.js';
import { loadPortfolioManifest } from '../portfolio/load-portfolio.js';
import { planPortfolioDryRun } from '../portfolio/plan-portfolio.js';

type RunPortfolioArgv = {
  readonly manifest: string;
  readonly due?: boolean | undefined;
  readonly analysis?: string | readonly (string | readonly string[])[] | undefined;
  readonly target?: string | readonly (string | readonly string[])[] | undefined;
  readonly date?: string | undefined;
  readonly window?: string | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
  readonly includePaused?: boolean | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly notify?: boolean | undefined;
  readonly publish?: boolean | undefined;
  readonly updateLatest?: boolean | undefined;
  readonly concurrency?: number | undefined;
};

export const runPortfolioCommand: CommandModule<object, RunPortfolioArgv> = {
  command: 'run-portfolio',
  describe: 'plan or run generic portfolio automation from a manifest',
  builder: (argv) =>
    argv
      .option('manifest', {
        type: 'string',
        demandOption: true,
        describe: 'Path to a portfolio manifest JSON file',
      })
      .option('due', {
        type: 'boolean',
        default: false,
        describe: 'Plan tasks due at invocation time',
      })
      .option('analysis', {
        type: 'string',
        array: true,
        describe: 'Analysis id to include; repeat to include multiple analyses',
      })
      .option('target', {
        type: 'string',
        array: true,
        describe: 'Target id to include; repeat to include multiple targets',
      })
      .option('date', {
        type: 'string',
        describe:
          'Override planned task windows with one local date (YYYY-MM-DD, today, or yesterday) and plan only tasks due on that day',
      })
      .option('window', {
        type: 'string',
        choices: ['current-workday', 'previous-workday', 'previous-5-workdays'] as const,
        describe: 'Override planned task windows with a named local date window',
      })
      .option('start-date', {
        type: 'string',
        describe: 'Override planned task windows with an inclusive start local date',
      })
      .option('end-date', {
        type: 'string',
        describe: 'Override planned task windows with an inclusive end local date',
      })
      .option('include-paused', {
        type: 'boolean',
        default: false,
        describe: 'Include paused targets when no explicit target filter is provided',
      })
      .option('include-archived', {
        type: 'boolean',
        default: false,
        describe: 'Include archived targets',
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'Print the execution plan without running models, publishing, or notifications',
      })
      .option('notify', {
        type: 'boolean',
        default: true,
        describe: 'Enable notification delivery in execution modes',
      })
      .option('publish', {
        type: 'boolean',
        default: true,
        describe: 'Enable report publishing in execution modes',
      })
      .option('update-latest', {
        type: 'boolean',
        default: false,
        describe: 'Allow latest report views to be updated for historical windows',
      })
      .option('concurrency', {
        type: 'number',
        default: 1,
        describe:
          'Maximum number of analysis/target task lanes to execute in parallel; tasks for the same target stay ordered',
      }),
  handler: async (argv) => {
    const loaded = await loadPortfolioManifest(argv.manifest);
    const options = {
      manifest: loaded.manifest,
      manifestPath: loaded.manifestPath,
      manifestHash: loaded.manifestHash,
      analysisIds: normalizeArray(argv.analysis),
      targetIds: normalizeArray(argv.target),
      due: argv.due,
      date: argv.date,
      window: argv.window,
      startDate: argv.startDate,
      endDate: argv.endDate,
      includePaused: argv.includePaused,
      includeArchived: argv.includeArchived,
      notify: argv.notify,
      publish: argv.publish,
      updateLatest: argv.updateLatest,
      concurrency: argv.concurrency,
    };

    if (argv.dryRun === true) {
      const plan = planPortfolioDryRun(options);
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    const result = await executePortfolioAnalyses(options);
    if (
      result.summary.failed > 0 ||
      result.taskResults.some(
        (taskResult) =>
          taskResult.status === 'completed' &&
          'notification' in taskResult &&
          taskResult.notification?.status === 'failed',
      ) ||
      result.git.status === 'failed'
    ) {
      process.exitCode = 1;
    }
    console.log(JSON.stringify(result, null, 2));
  },
};

function normalizeArray(
  value: string | readonly (string | readonly string[])[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return [value];
  }
  return value.flatMap((item) => (typeof item === 'string' ? item : [...item]));
}
