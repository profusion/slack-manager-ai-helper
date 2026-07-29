import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type JsonObject,
  materializeRunAndNotifyConfig,
  type PortfolioManifest,
} from './load-portfolio.js';
import type { PlannedPortfolioTask } from './plan-portfolio.js';
import type { PortfolioAnalysisReportPublication } from './publish-portfolio.js';

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

export type PortfolioCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

export type PortfolioNotificationResult =
  | {
      readonly status: 'delivered';
      readonly exitCode: 0;
    }
  | {
      readonly status: 'failed';
      readonly exitCode: number;
      readonly stderr: string;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'not_published';
    };

export async function notifyPortfolioAnalysisReport(input: {
  readonly manifest: PortfolioManifest;
  readonly task: Extract<PlannedPortfolioTask, { readonly type: 'analysis' | 'rollup' }>;
  readonly publication: PortfolioAnalysisReportPublication | undefined;
  readonly commandRunner?: PortfolioCommandRunner | undefined;
  readonly command?: string | undefined;
}): Promise<PortfolioNotificationResult> {
  if (
    input.publication?.status !== 'published' ||
    input.publication.archiveRepoPath === undefined ||
    input.publication.reportPath === undefined
  ) {
    return {
      status: 'skipped',
      reason: 'not_published',
    };
  }

  const reportPath = path.join(input.publication.archiveRepoPath, input.publication.reportPath);
  const config = {
    ...materializeRunAndNotifyConfig({
      manifest: input.manifest,
      analysisId: input.task.analysisId,
      targetId: input.task.targetId,
      runId: input.task.type === 'analysis' ? input.task.runId : undefined,
      rollupId: input.task.type === 'rollup' ? input.task.rollupId : undefined,
    }),
    stdout: {
      format: 'markdown',
    },
  };
  const result = await (input.commandRunner ?? defaultCommandRunner)(
    input.command ?? resolveRunAndNotifyCommand(),
    [...configToCliArgs(config), '--', 'cat', reportPath],
  );
  if (result.exitCode === 0) {
    return {
      status: 'delivered',
      exitCode: 0,
    };
  }
  return {
    status: 'failed',
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
}

function resolveRunAndNotifyCommand(): string {
  try {
    const packageJsonPath = requireFromHere.resolve('run-and-notify/package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      readonly bin?: { readonly 'run-and-notify'?: string } | string | undefined;
    };
    const binaryRelativePath =
      typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.['run-and-notify'];
    if (binaryRelativePath === undefined) {
      return 'run-and-notify';
    }
    const binaryPath = path.join(path.dirname(packageJsonPath), binaryRelativePath);
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // Fall back to PATH for development checkouts or unusual package layouts.
  }
  return 'run-and-notify';
}

function configToCliArgs(config: JsonObject): string[] {
  return flattenConfigArgs([], config);
}

function flattenConfigArgs(pathSegments: readonly string[], value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenConfigArgs(pathSegments, item));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenConfigArgs([...pathSegments, key], child),
    );
  }
  if (pathSegments.length === 0 || value === null) {
    return [];
  }
  return [`--${pathSegments.map(toKebabCase).join('.')}=${String(value)}`];
}

function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const result = await execFileAsync(command, [...args], {
      encoding: 'utf8',
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (isExecError(error)) {
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr : String(error),
      };
    }
    throw error;
  }
}

function isExecError(input: unknown): input is {
  readonly code?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
} {
  return typeof input === 'object' && input !== null;
}
