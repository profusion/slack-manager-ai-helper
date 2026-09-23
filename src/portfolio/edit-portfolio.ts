import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChannelConfig, ConfiguredUser } from '../types.js';
import { parseJsonObject } from '../utils/json.js';
import {
  type JsonObject,
  type PortfolioAnalysis,
  type PortfolioManifest,
  type PortfolioTarget,
  validateRawPortfolioManifest,
} from './load-portfolio.js';

const initCwdEnvKey = 'INIT_CWD';
export function resolveCliPath(input: string): string {
  return path.isAbsolute(input)
    ? input
    : path.resolve(process.env[initCwdEnvKey] ?? process.cwd(), input);
}
export async function readEditableManifest(
  manifestPath: string,
  createIfMissing: boolean,
): Promise<PortfolioManifest> {
  if (!(await fileExists(manifestPath))) {
    if (!createIfMissing)
      throw new Error(
        `Portfolio manifest not found: ${manifestPath}. Pass --create to start a new manifest.`,
      );
    return { schemaVersion: 1, analyses: [] };
  }
  return validateManifest(
    parseJsonObject(await readFile(manifestPath, 'utf8'), manifestPath),
    manifestPath,
  );
}
export function validateManifest(raw: unknown, manifestPath: string): PortfolioManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`Invalid portfolio manifest ${manifestPath}: expected JSON object`);
  return validateRawPortfolioManifest(raw as Record<string, unknown>, manifestPath);
}
export async function saveManifest(
  manifestPath: string,
  manifest: PortfolioManifest,
  now: Date,
): Promise<string | null> {
  validateManifest(manifest, manifestPath);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const backupPath = (await fileExists(manifestPath))
    ? `${manifestPath}.${timestampForBackup(now)}.bak`
    : null;
  if (backupPath) await copyFile(manifestPath, backupPath);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return backupPath;
}
export function applyMemberMove(input: {
  readonly manifest: PortfolioManifest;
  readonly sourceAnalysisId: string;
  readonly sourceTargetId: string;
  readonly destinationAnalysisId: string;
  readonly destinationTargetId: string;
  readonly member: ConfiguredUser;
}): PortfolioManifest {
  const removed = updateTargetChannels(
    input.manifest,
    input.sourceAnalysisId,
    input.sourceTargetId,
    (channels) =>
      channels.map((channel) =>
        withChannelUsers(
          channel,
          (channel.users ?? []).filter((user) => user.id !== input.member.id),
        ),
      ),
  );
  return updateTargetChannels(
    removed,
    input.destinationAnalysisId,
    input.destinationTargetId,
    (channels) =>
      channels.map((channel) =>
        (channel.users ?? []).some((user) => user.id === input.member.id)
          ? channel
          : withChannelUsers(channel, [...(channel.users ?? []), input.member]),
      ),
  );
}
export function stripUndefinedObject(input: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) if (value !== undefined) output[key] = value;
  return output;
}
export function overrideChannelsFromTarget(target: PortfolioTarget): readonly ChannelConfig[] {
  // biome-ignore lint/complexity/useLiteralKeys: JsonObject exposes channels through its index signature.
  const channels = target.analysisConfig?.['channels'];
  return Array.isArray(channels) ? channels.filter(isChannelConfig) : [];
}
function isChannelConfig(value: unknown): value is ChannelConfig {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'id' in value);
}
export function withChannelUsers(
  channel: ChannelConfig,
  users: readonly ConfiguredUser[],
): ChannelConfig {
  const { users: _removed, ...rest } = channel;
  return users.length === 0 ? rest : { ...rest, users };
}
export function updateTargetChannels(
  manifest: PortfolioManifest,
  analysisId: string,
  targetId: string,
  update: (channels: readonly ChannelConfig[]) => readonly ChannelConfig[],
): PortfolioManifest {
  return updateTarget(manifest, analysisId, targetId, (target) => {
    const nextChannels = update(overrideChannelsFromTarget(target));
    const analysisConfig = stripUndefinedObject({
      ...(target.analysisConfig ?? {}),
      channels: nextChannels.length > 0 ? nextChannels : undefined,
    });
    if (Object.keys(analysisConfig).length === 0) {
      const { analysisConfig: _removed, ...rest } = target;
      return rest;
    }
    return { ...target, analysisConfig };
  });
}
export function updateTarget(
  manifest: PortfolioManifest,
  analysisId: string,
  targetId: string,
  update: (target: PortfolioTarget) => PortfolioTarget,
): PortfolioManifest {
  return updateAnalysis(manifest, analysisId, (analysis) => ({
    ...analysis,
    targets: analysis.targets.map((target) => (target.id === targetId ? update(target) : target)),
  }));
}
function updateAnalysis(
  manifest: PortfolioManifest,
  analysisId: string,
  update: (analysis: PortfolioAnalysis) => PortfolioAnalysis,
): PortfolioManifest {
  return {
    ...manifest,
    analyses: manifest.analyses.map((analysis) =>
      analysis.id === analysisId ? update(analysis) : analysis,
    ),
  };
}
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
export function timestampForBackup(now: Date): string {
  return now
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
}
