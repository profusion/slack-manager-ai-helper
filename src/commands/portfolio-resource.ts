import type { Argv, CommandModule } from 'yargs';
import {
  applyMemberMove,
  overrideChannelsFromTarget,
  resolveCliPath,
  saveManifest,
  updateTarget,
  updateTargetChannels,
  withChannelUsers,
} from '../portfolio/edit-portfolio.js';
import {
  loadPortfolioManifest,
  type PortfolioAnalysis,
  type PortfolioManifest,
  type PortfolioTarget,
} from '../portfolio/load-portfolio.js';
import type { ConfiguredUser } from '../types.js';

type Action = 'list' | 'add' | 'remove' | 'move';
type Args = {
  manifest: string;
  analysis?: string | undefined;
  'dry-run': boolean;
  'auto-status'?: boolean | undefined;
  action: Action;
  target?: string | undefined;
  user?: string | undefined;
  channel?: string | undefined;
  role?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

export const portfolioResourceCommand: CommandModule<object, Args> = {
  command: 'portfolio-resource <action>',
  describe: 'non-interactively list or edit portfolio members',
  builder: (argv) =>
    argv
      .positional('action', {
        choices: ['list', 'add', 'remove', 'move'] as const,
        demandOption: true,
      })
      .option('manifest', { type: 'string', demandOption: true })
      .option('analysis', { type: 'string' })
      .option('dry-run', { type: 'boolean', default: false })
      .option('auto-status', {
        type: 'boolean',
        default: true,
        describe:
          'Pause empty active targets and activate paused targets receiving their first member',
      })
      .option('target', { type: 'string' })
      .option('user', { type: 'string' })
      .option('channel', { type: 'string' })
      .option('role', { type: 'string' })
      .option('from', { type: 'string' })
      .option('to', { type: 'string' })
      .check(checkArgs) as Argv<Args>,
  handler: async (argv) => runPortfolioResource(argv),
};

function checkArgs(argv: Args): true {
  if (argv.action === 'add' && (!argv.target || !argv.user || !argv.channel))
    throw new Error('add requires --target, --user, and --channel');
  if (argv.action === 'remove' && (!argv.target || !argv.user))
    throw new Error('remove requires --target and --user');
  if (argv.action === 'move' && (!argv.from || !argv.to || !argv.user))
    throw new Error('move requires --from, --to, and --user');
  return true;
}

export async function runPortfolioResource(argv: Args): Promise<void> {
  const manifestPath = resolveCliPath(argv.manifest);
  const loaded = await loadPortfolioManifest(manifestPath);
  const analysis = resolveAnalysis(loaded.manifest, argv.analysis);
  let manifest = loaded.manifest;
  let changed = false;
  let detail: ReturnType<typeof listDetail> | ReturnType<typeof mutationDetail>;
  if (argv.action === 'list') detail = listDetail(analysis, argv.target);
  else {
    const user = resolveUser(loaded.manifest, argv.user as string);
    if (argv.action === 'add')
      ({ manifest, changed, detail } = addMember(
        manifest,
        analysis,
        argv.target as string,
        argv.channel as string,
        user,
        argv.role,
      ));
    else if (argv.action === 'remove')
      ({ manifest, changed, detail } = removeMember(
        manifest,
        analysis,
        argv.target as string,
        argv.channel,
        user,
      ));
    else
      ({ manifest, changed, detail } = moveMember(
        manifest,
        analysis,
        argv.from as string,
        argv.to as string,
        user,
      ));
    const affectedTargetIds = detail.targets.map((item) => (item as { targetId: string }).targetId);
    const statusResult = applyAutomaticStatuses(
      loaded.manifest,
      manifest,
      analysis.id,
      affectedTargetIds,
      argv['auto-status'] !== false,
    );
    manifest = statusResult.manifest;
    detail.statusChanges = statusResult.statusChanges;
  }
  const backupPath =
    changed && !argv['dry-run'] ? await saveManifest(manifestPath, manifest, new Date()) : null;
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: argv.action,
        manifestPath,
        analysisId: analysis.id,
        backupPath,
        changed,
        dryRun: argv['dry-run'],
        detail,
      },
      null,
      2,
    ),
  );
}

function resolveAnalysis(manifest: PortfolioManifest, id?: string): PortfolioAnalysis {
  if (!id) {
    if (manifest.analyses.length !== 1)
      throw new Error('Multiple analyses found; pass --analysis <id>');
    return manifest.analyses[0] as PortfolioAnalysis;
  }
  const analysis = manifest.analyses.find((item) => item.id === id);
  if (!analysis) throw new Error(`Unknown analysis: ${id}`);
  return analysis;
}
function target(analysis: PortfolioAnalysis, id: string): PortfolioTarget {
  const value = analysis.targets.find((item) => item.id === id);
  if (!value) throw new Error(`Unknown target: ${id}`);
  return value;
}
function listDetail(analysis: PortfolioAnalysis, targetId?: string) {
  const targets = targetId ? [target(analysis, targetId)] : analysis.targets;
  return {
    statusChanges: [] as StatusChange[],
    targets: targets.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      channels: overrideChannelsFromTarget(item).map((channel) => ({
        id: channel.id,
        ...(channel.name ? { name: channel.name } : {}),
        users: (channel.users ?? []).map(userJson),
      })),
    })),
  };
}
function allUsers(manifest: PortfolioManifest): ConfiguredUser[] {
  return manifest.analyses.flatMap((a) =>
    a.targets.flatMap((t) => overrideChannelsFromTarget(t).flatMap((c) => c.users ?? [])),
  );
}
function resolveUser(manifest: PortfolioManifest, query: string): ConfiguredUser {
  const users = allUsers(manifest);
  const byId = users.find((user) => user.id === query);
  if (byId) return byId;
  const matches = [
    ...new Map(
      users
        .filter((user) => user.name?.toLocaleLowerCase() === query.toLocaleLowerCase())
        .map((user) => [user.id, user]),
    ).values(),
  ];
  if (matches.length === 0) throw new Error(`Unknown user: ${query}`);
  if (matches.length > 1) throw new Error(`Ambiguous user name: ${query}`);
  return matches[0] as ConfiguredUser;
}
function userJson(user: ConfiguredUser) {
  return {
    id: user.id,
    ...(user.name ? { name: user.name } : {}),
    ...(user.role ? { role: user.role } : {}),
  };
}
function mutationDetail(
  user: ConfiguredUser,
  targets: readonly { targetId: string; channels: readonly string[] }[],
) {
  return { user: userJson(user), targets, statusChanges: [] as StatusChange[] };
}

type StatusChange = {
  readonly targetId: string;
  readonly from: 'active' | 'paused';
  readonly to: 'active' | 'paused';
};
function memberCount(value: PortfolioTarget): number {
  return overrideChannelsFromTarget(value).reduce(
    (count, channel) => count + (channel.users?.length ?? 0),
    0,
  );
}
function applyAutomaticStatuses(
  before: PortfolioManifest,
  after: PortfolioManifest,
  analysisId: string,
  targetIds: readonly string[],
  enabled: boolean,
): { manifest: PortfolioManifest; statusChanges: StatusChange[] } {
  if (!enabled) return { manifest: after, statusChanges: [] };
  const beforeAnalysis = resolveAnalysis(before, analysisId);
  const afterAnalysis = resolveAnalysis(after, analysisId);
  let manifest = after;
  const statusChanges: StatusChange[] = [];
  for (const targetId of [...new Set(targetIds)]) {
    const previous = target(beforeAnalysis, targetId);
    const current = target(afterAnalysis, targetId);
    const beforeCount = memberCount(previous);
    const afterCount = memberCount(current);
    if (current.status === 'archived') continue;
    let to: 'active' | 'paused' | undefined;
    if (current.status === 'active' && afterCount === 0) to = 'paused';
    else if (current.status === 'paused' && beforeCount === 0 && afterCount > 0) to = 'active';
    if (!to) continue;
    statusChanges.push({ targetId, from: current.status, to });
    manifest = updateTarget(manifest, analysisId, targetId, (item) => ({ ...item, status: to }));
  }
  return { manifest, statusChanges };
}

function addMember(
  manifest: PortfolioManifest,
  analysis: PortfolioAnalysis,
  targetId: string,
  channelId: string,
  known: ConfiguredUser,
  role?: string,
) {
  const selected = target(analysis, targetId);
  const channels = overrideChannelsFromTarget(selected);
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) throw new Error(`Unknown channel ${channelId} on target ${targetId}`);
  if (channel.users?.some((user) => user.id === known.id))
    throw new Error(`User ${known.id} is already on channel ${channelId}`);
  const member: ConfiguredUser = {
    id: known.id,
    ...(known.name ? { name: known.name } : {}),
    ...((role ?? known.role) ? { role: role ?? known.role } : {}),
  };
  return {
    manifest: updateTargetChannels(manifest, analysis.id, targetId, (items) =>
      items.map((item) =>
        item.id === channelId ? withChannelUsers(item, [...(item.users ?? []), member]) : item,
      ),
    ),
    changed: true,
    detail: mutationDetail(member, [{ targetId, channels: [channelId] }]),
  };
}
function removeMember(
  manifest: PortfolioManifest,
  analysis: PortfolioAnalysis,
  targetId: string,
  channelId: string | undefined,
  member: ConfiguredUser,
) {
  const selected = target(analysis, targetId);
  const channels = overrideChannelsFromTarget(selected);
  if (channelId && !channels.some((item) => item.id === channelId))
    throw new Error(`Unknown channel ${channelId} on target ${targetId}`);
  const affected = channels
    .filter(
      (item) =>
        (!channelId || item.id === channelId) && item.users?.some((u) => u.id === member.id),
    )
    .map((item) => item.id);
  if (affected.length === 0)
    throw new Error(
      `User ${member.id} is not present on target ${targetId}${channelId ? ` channel ${channelId}` : ''}`,
    );
  return {
    manifest: updateTargetChannels(manifest, analysis.id, targetId, (items) =>
      items.map((item) =>
        affected.includes(item.id)
          ? withChannelUsers(
              item,
              (item.users ?? []).filter((u) => u.id !== member.id),
            )
          : item,
      ),
    ),
    changed: true,
    detail: mutationDetail(member, [{ targetId, channels: affected }]),
  };
}
function moveMember(
  manifest: PortfolioManifest,
  analysis: PortfolioAnalysis,
  from: string,
  to: string,
  member: ConfiguredUser,
) {
  if (from === to) throw new Error('--from and --to must be different');
  const source = target(analysis, from);
  const destination = target(analysis, to);
  const sourceChannels = overrideChannelsFromTarget(source)
    .filter((c) => c.users?.some((u) => u.id === member.id))
    .map((c) => c.id);
  if (sourceChannels.length === 0)
    throw new Error(`User ${member.id} is not present on source target ${from}`);
  const destinationChannels = overrideChannelsFromTarget(destination)
    .filter((c) => !c.users?.some((u) => u.id === member.id))
    .map((c) => c.id);
  return {
    manifest: applyMemberMove({
      manifest,
      sourceAnalysisId: analysis.id,
      sourceTargetId: from,
      destinationAnalysisId: analysis.id,
      destinationTargetId: to,
      member,
    }),
    changed: true,
    detail: mutationDetail(member, [
      { targetId: from, channels: sourceChannels },
      { targetId: to, channels: destinationChannels },
    ]),
  };
}
