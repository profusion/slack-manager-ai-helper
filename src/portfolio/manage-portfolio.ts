import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  checkbox,
  confirm,
  editor,
  input,
  number as numberPrompt,
  search,
  select,
} from '@inquirer/prompts';
import { resolveConfigPaths } from '../config/load-config.js';
import {
  type PromptApi,
  promptForChannels,
  promptForModel,
  promptForProviderScoringDefaults,
  readDirectory,
} from '../config-wizard/wizard.js';
import { type GenerateModelText, generateModelText } from '../llm/generate.js';
import { type SlacrawlDirectory, type SlacrawlUserInfo, userLabel } from '../slacrawl/directory.js';
import type { AppConfig, ChannelConfig, ConfiguredUser, ResolvedConfig } from '../types.js';
import { hashJson, parseJsonObject } from '../utils/json.js';
import { resolveLocalTimeZone } from '../utils/local-time.js';
import {
  type JsonObject,
  materializeAnalysisConfig,
  type PortfolioAnalysis,
  type PortfolioMaintenance,
  type PortfolioManifest,
  type PortfolioRollup,
  type PortfolioRun,
  type PortfolioTarget,
  validateRawPortfolioManifest,
} from './load-portfolio.js';
import { planPortfolioDryRun } from './plan-portfolio.js';

type WizardAction =
  | 'list'
  | 'add-analysis'
  | 'edit-analysis-defaults'
  | 'add-target'
  | 'edit-target'
  | 'edit-target-channels'
  | 'edit-target-model'
  | 'edit-target-scored-defaults'
  | 'set-target-status'
  | 'move-member'
  | 'add-run'
  | 'add-rollup'
  | 'add-maintenance'
  | 'edit-notifications'
  | 'preview'
  | 'validate'
  | 'save-exit'
  | 'exit';

type EditTargetAction = 'name' | 'json' | 'notifications' | 'channel-members' | typeof BACK;

export type PortfolioPromptApi = {
  readonly input: typeof input;
  readonly confirm: typeof confirm;
  readonly select: typeof select;
  readonly editor: typeof editor;
  readonly number: typeof numberPrompt;
  readonly checkbox: typeof checkbox;
  readonly search: typeof search;
};

export type ManagePortfolioOptions = {
  readonly manifest: string;
  readonly now?: Date | undefined;
  readonly createIfMissing?: boolean | undefined;
};

export type ManagePortfolioResult = {
  readonly manifestPath: string;
  readonly manifest: PortfolioManifest;
  readonly saved: boolean;
  readonly backupPath: string | null;
  readonly previewed: boolean;
};

const defaultPrompts: PortfolioPromptApi = {
  input,
  confirm,
  select,
  editor,
  number: numberPrompt,
  checkbox,
  search,
};
const initCwdEnvKey = 'INIT_CWD';
const BACK = '__back__' as const;

type TargetSelection = {
  readonly analysis: PortfolioAnalysis;
  readonly target: PortfolioTarget;
};

type RunAndNotifyConfigScope = 'defaults' | 'override';

export async function runManagePortfolioWizard(
  options: ManagePortfolioOptions,
  prompts: PortfolioPromptApi = defaultPrompts,
  generateText: GenerateModelText = generateModelText,
): Promise<ManagePortfolioResult> {
  const manifestPath = resolveCliPath(options.manifest);
  let manifest = await readEditableManifest(manifestPath, options.createIfMissing ?? true);
  let dirty = false;
  let saved = false;
  let backupPath: string | null = null;
  let previewed = false;
  const now = options.now ?? new Date();

  for (;;) {
    const action = await prompts.select<WizardAction>({
      message: `Manage ${path.basename(manifestPath)}`,
      choices: actionChoices(manifest),
    });

    const outcome = await handleWizardAction({
      action,
      manifest,
      manifestPath,
      prompts,
      generateText,
      now,
      dirty,
      saved,
      backupPath,
      previewed,
    });
    manifest = outcome.manifest;
    dirty = outcome.dirty;
    saved = outcome.saved;
    backupPath = outcome.backupPath;
    previewed = outcome.previewed;
    if (outcome.exit) {
      return outcome.exit;
    }
  }
}

type WizardLoopState = {
  readonly manifest: PortfolioManifest;
  readonly dirty: boolean;
  readonly saved: boolean;
  readonly backupPath: string | null;
  readonly previewed: boolean;
};

async function handleWizardAction(input: {
  readonly action: WizardAction;
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly prompts: PortfolioPromptApi;
  readonly generateText: GenerateModelText;
  readonly now: Date;
  readonly dirty: boolean;
  readonly saved: boolean;
  readonly backupPath: string | null;
  readonly previewed: boolean;
}): Promise<WizardLoopState & { readonly exit: ManagePortfolioResult | null }> {
  const base = {
    manifest: input.manifest,
    dirty: input.dirty,
    saved: input.saved,
    backupPath: input.backupPath,
    previewed: input.previewed,
    exit: null,
  };

  switch (input.action) {
    case 'list':
      printManifestSummary(input.manifest);
      return base;
    case 'add-analysis':
      return {
        ...base,
        manifest: await addAnalysis(
          input.manifest,
          input.manifestPath,
          input.prompts,
          input.generateText,
        ),
        dirty: true,
      };
    case 'edit-analysis-defaults':
      return applyOptionalManifestUpdate(
        base,
        await editAnalysisDefaults(input.manifest, input.prompts),
      );
    case 'add-target':
      return applyOptionalManifestUpdate(
        base,
        await addTarget(input.manifest, input.manifestPath, input.prompts, input.generateText),
      );
    case 'edit-target':
      return applyOptionalManifestUpdate(
        base,
        await editTarget(input.manifest, input.manifestPath, input.prompts),
      );
    case 'edit-target-channels':
      return applyOptionalManifestUpdate(
        base,
        await editTargetChannels(
          input.manifest,
          input.manifestPath,
          input.prompts,
          input.generateText,
        ),
      );
    case 'edit-target-model':
      return applyOptionalManifestUpdate(
        base,
        await editTargetModel(input.manifest, input.manifestPath, input.prompts),
      );
    case 'edit-target-scored-defaults':
      return applyOptionalManifestUpdate(
        base,
        await editTargetScoredDefaults(input.manifest, input.manifestPath, input.prompts),
      );
    case 'set-target-status':
      return applyOptionalManifestUpdate(
        base,
        await setTargetStatus(input.manifest, input.prompts, input.now),
      );
    case 'move-member':
      return applyOptionalManifestUpdate(
        base,
        await moveMemberBetweenTargets(input.manifest, input.prompts),
      );
    case 'add-run':
      return applyOptionalManifestUpdate(base, await addRun(input.manifest, input.prompts));
    case 'add-rollup':
      return applyOptionalManifestUpdate(base, await addRollup(input.manifest, input.prompts));
    case 'add-maintenance':
      return applyOptionalManifestUpdate(base, await addMaintenance(input.manifest, input.prompts));
    case 'edit-notifications':
      return applyOptionalManifestUpdate(
        base,
        await editNotifications(input.manifest, input.prompts),
      );
    case 'preview':
      validateManifest(input.manifest, input.manifestPath);
      printPreview(input.manifest, input.manifestPath, input.now);
      return { ...base, previewed: true };
    case 'validate':
      validateManifest(input.manifest, input.manifestPath);
      console.log(`Valid portfolio manifest: ${input.manifestPath}`);
      return base;
    case 'save-exit': {
      const savedBackupPath = await saveManifest(input.manifestPath, input.manifest, input.now);
      return {
        ...base,
        backupPath: savedBackupPath,
        saved: true,
        dirty: false,
        exit: {
          manifestPath: input.manifestPath,
          manifest: input.manifest,
          saved: true,
          backupPath: savedBackupPath,
          previewed: input.previewed,
        },
      };
    }
    case 'exit':
      if (
        !input.dirty ||
        (await input.prompts.confirm({
          message: 'Discard unsaved portfolio manifest changes?',
          default: false,
        }))
      ) {
        return {
          ...base,
          exit: {
            manifestPath: input.manifestPath,
            manifest: input.manifest,
            saved: input.saved,
            backupPath: input.backupPath,
            previewed: input.previewed,
          },
        };
      }
      return base;
  }
}

function applyOptionalManifestUpdate(
  base: WizardLoopState & { readonly exit: ManagePortfolioResult | null },
  updated: PortfolioManifest | null,
): WizardLoopState & { readonly exit: ManagePortfolioResult | null } {
  if (!updated) {
    return base;
  }
  return {
    ...base,
    manifest: updated,
    dirty: true,
  };
}

function resolveCliPath(input: string): string {
  if (path.isAbsolute(input)) {
    return input;
  }
  return path.resolve(process.env[initCwdEnvKey] ?? process.cwd(), input);
}

async function readEditableManifest(
  manifestPath: string,
  createIfMissing: boolean,
): Promise<PortfolioManifest> {
  if (!(await fileExists(manifestPath))) {
    if (!createIfMissing) {
      throw new Error(
        `Portfolio manifest not found: ${manifestPath}. Pass --create to start a new manifest.`,
      );
    }
    return {
      schemaVersion: 1,
      analyses: [],
    };
  }

  const text = await readFile(manifestPath, 'utf8');
  return validateManifest(parseJsonObject(text, manifestPath), manifestPath);
}

function validateManifest(raw: unknown, manifestPath: string): PortfolioManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid portfolio manifest ${manifestPath}: expected JSON object`);
  }
  return validateRawPortfolioManifest(raw as Record<string, unknown>, manifestPath);
}

async function saveManifest(
  manifestPath: string,
  manifest: PortfolioManifest,
  now: Date,
): Promise<string | null> {
  validateManifest(manifest, manifestPath);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const backupPath = (await fileExists(manifestPath))
    ? `${manifestPath}.${timestampForBackup(now)}.bak`
    : null;
  if (backupPath) {
    await copyFile(manifestPath, backupPath);
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return backupPath;
}

function actionChoices(manifest: PortfolioManifest) {
  const hasAnalyses = manifest.analyses.length > 0;
  const hasTargets = manifest.analyses.some((analysis) => analysis.targets.length > 0);
  return [
    { name: 'List portfolio', value: 'list' as const },
    { name: 'Add analysis', value: 'add-analysis' as const },
    {
      name: 'Edit analysis defaults JSON',
      value: 'edit-analysis-defaults' as const,
      disabled: !hasAnalyses,
    },
    { name: 'Add target', value: 'add-target' as const, disabled: !hasAnalyses },
    { name: 'Edit target', value: 'edit-target' as const, disabled: !hasTargets },
    { name: 'Edit target channels', value: 'edit-target-channels' as const, disabled: !hasTargets },
    {
      name: 'Edit target model override',
      value: 'edit-target-model' as const,
      disabled: !hasTargets,
    },
    {
      name: 'Edit target scored matcher defaults',
      value: 'edit-target-scored-defaults' as const,
      disabled: !hasTargets,
    },
    {
      name: 'Pause, resume, or archive target',
      value: 'set-target-status' as const,
      disabled: !hasTargets,
    },
    {
      name: 'Move member between targets',
      value: 'move-member' as const,
      disabled: !hasTargets,
    },
    { name: 'Add run schedule', value: 'add-run' as const, disabled: !hasAnalyses },
    { name: 'Add rollup', value: 'add-rollup' as const, disabled: !hasAnalyses },
    { name: 'Add maintenance task', value: 'add-maintenance' as const, disabled: !hasAnalyses },
    { name: 'Edit notification config', value: 'edit-notifications' as const },
    { name: 'Preview dry-run plan', value: 'preview' as const },
    { name: 'Validate', value: 'validate' as const },
    { name: 'Save and exit', value: 'save-exit' as const },
    { name: 'Exit without saving', value: 'exit' as const },
  ];
}

async function addAnalysis(
  manifest: PortfolioManifest,
  manifestPath: string,
  prompts: PortfolioPromptApi,
  generateText: GenerateModelText,
): Promise<PortfolioManifest> {
  const analysis: PortfolioAnalysis = {
    id: await promptSlug(prompts, 'Analysis id'),
    name: await promptRequired(prompts, 'Analysis name'),
    runs: [
      {
        id: 'daily',
        schedule: { kind: 'workdays' },
        window: { date: 'today' },
      },
    ],
    targets: [],
  };
  ensureUnusedId(manifest.analyses, analysis.id, 'analysis');
  const withAnalysis = {
    ...manifest,
    analyses: [...manifest.analyses, analysis],
  };
  if (
    await prompts.confirm({
      message: 'Add the first target now?',
      default: true,
    })
  ) {
    return addTargetToAnalysis(withAnalysis, analysis.id, manifestPath, prompts, generateText);
  }
  return withAnalysis;
}

async function editAnalysisDefaults(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const analysis = await selectAnalysis(manifest, prompts);
  if (!analysis) {
    return null;
  }
  const defaults = await promptJsonObject(prompts, {
    message: `Edit defaults JSON for ${analysis.id}`,
    initial: analysis.defaults ?? {},
    allowBack: true,
  });
  if (!defaults) {
    return null;
  }
  return updateAnalysis(manifest, analysis.id, (value) => ({ ...value, defaults }));
}

async function addTarget(
  manifest: PortfolioManifest,
  manifestPath: string,
  prompts: PortfolioPromptApi,
  generateText: GenerateModelText,
): Promise<PortfolioManifest | null> {
  const analysis = await selectAnalysis(manifest, prompts);
  if (!analysis) {
    return null;
  }
  return addTargetToAnalysis(manifest, analysis.id, manifestPath, prompts, generateText);
}

async function addTargetToAnalysis(
  manifest: PortfolioManifest,
  analysisId: string,
  manifestPath: string,
  prompts: PortfolioPromptApi,
  generateText: GenerateModelText,
): Promise<PortfolioManifest> {
  const analysis = manifest.analyses.find((item) => item.id === analysisId);
  if (!analysis) {
    throw new Error(`Unknown analysis: ${analysisId}`);
  }

  const target = await promptTarget(manifest, analysis, manifestPath, prompts, generateText);
  ensureUnusedId(analysis.targets, target.id, 'target');
  return updateAnalysis(manifest, analysisId, (value) => ({
    ...value,
    targets: [...value.targets, target],
  }));
}

async function editTarget(
  manifest: PortfolioManifest,
  manifestPath: string,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  let selection = await selectTarget(manifest, prompts);
  if (!selection) {
    return null;
  }

  let nextManifest = manifest;
  let changed = false;
  for (;;) {
    const action = await prompts.select<EditTargetAction>({
      message: `Edit ${selection.target.name}`,
      choices: [
        { name: 'Edit display name', value: 'name' },
        { name: 'Edit channel members', value: 'channel-members' },
        { name: 'Edit analysisConfig JSON', value: 'json' },
        { name: 'Edit runAndNotifyConfig', value: 'notifications' },
        { name: '← Back to main menu', value: BACK },
      ],
    });
    if (action === BACK) {
      return changed ? nextManifest : null;
    }

    const update = await applyEditTargetAction({
      action,
      manifest: nextManifest,
      manifestPath,
      selection,
      prompts,
    });
    if (!update) {
      continue;
    }
    nextManifest = update.manifest;
    changed = update.changed || changed;
    selection = update.selection;
  }
}

type EditTargetUpdate = {
  readonly manifest: PortfolioManifest;
  readonly selection: TargetSelection;
  readonly changed: boolean;
};

async function applyEditTargetAction(input: {
  readonly action: Exclude<EditTargetAction, typeof BACK>;
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly selection: TargetSelection;
  readonly prompts: PortfolioPromptApi;
}): Promise<EditTargetUpdate | null> {
  switch (input.action) {
    case 'name':
      return renameTarget(input.manifest, input.selection, input.prompts);
    case 'channel-members':
      return editTargetChannelMembersAction(
        input.manifest,
        input.manifestPath,
        input.selection,
        input.prompts,
      );
    case 'notifications':
      return editTargetNotificationsAction(input.manifest, input.selection, input.prompts);
    case 'json':
      return editTargetAnalysisConfigJson(input.manifest, input.selection, input.prompts);
  }
}

function selectionUpdate(
  manifest: PortfolioManifest,
  selection: TargetSelection,
): EditTargetUpdate {
  return {
    manifest,
    selection: refreshTargetSelection(manifest, selection) ?? selection,
    changed: true,
  };
}

async function renameTarget(
  manifest: PortfolioManifest,
  selection: TargetSelection,
  prompts: PortfolioPromptApi,
): Promise<EditTargetUpdate | null> {
  const name = await prompts.input({
    message: 'Target display name',
    default: selection.target.name,
    required: true,
  });
  if (name === selection.target.name) {
    return null;
  }
  return selectionUpdate(
    updateTarget(manifest, selection.analysis.id, selection.target.id, (target) => ({
      ...target,
      name,
    })),
    selection,
  );
}

async function editTargetChannelMembersAction(
  manifest: PortfolioManifest,
  manifestPath: string,
  selection: TargetSelection,
  prompts: PortfolioPromptApi,
): Promise<EditTargetUpdate | null> {
  const updated = await editTargetChannelMembers(manifest, manifestPath, selection, prompts);
  return updated ? selectionUpdate(updated, selection) : null;
}

async function editTargetNotificationsAction(
  manifest: PortfolioManifest,
  selection: TargetSelection,
  prompts: PortfolioPromptApi,
): Promise<EditTargetUpdate | null> {
  const mode = await prompts.select<'guided' | 'json' | typeof BACK>({
    message: 'runAndNotifyConfig editor',
    choices: [
      { name: 'Guided transport setup', value: 'guided' },
      { name: 'Edit raw JSON', value: 'json' },
      { name: '← Back', value: BACK },
    ],
  });
  if (mode === BACK) {
    return null;
  }
  const raw = await promptRunAndNotifyConfigForScope(prompts, {
    mode,
    initial: selection.target.runAndNotifyConfig ?? {},
    defaultName: selection.target.name,
    scope: 'override',
  });
  if (!raw) {
    return null;
  }
  return selectionUpdate(
    updateTarget(manifest, selection.analysis.id, selection.target.id, (target) =>
      applyTargetRunAndNotifyConfig(target, raw),
    ),
    selection,
  );
}

async function editTargetAnalysisConfigJson(
  manifest: PortfolioManifest,
  selection: TargetSelection,
  prompts: PortfolioPromptApi,
): Promise<EditTargetUpdate | null> {
  const analysisConfig = await promptJsonObject(prompts, {
    message: `Edit analysisConfig JSON for ${selection.target.id}`,
    initial: selection.target.analysisConfig ?? {},
    allowBack: true,
  });
  if (!analysisConfig) {
    return null;
  }
  return selectionUpdate(
    updateTarget(manifest, selection.analysis.id, selection.target.id, (target) => ({
      ...target,
      analysisConfig,
    })),
    selection,
  );
}

async function editTargetChannelMembers(
  manifest: PortfolioManifest,
  manifestPath: string,
  selection: TargetSelection,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const channels = overrideChannelsFromTarget(selection.target);
  if (channels.length === 0) {
    console.log(
      `Target ${selection.target.id} has no channel overrides to edit. Add channels first.`,
    );
    return null;
  }

  let nextManifest = manifest;
  let nextSelection = selection;
  let changed = false;

  for (;;) {
    const refreshedChannels = overrideChannelsFromTarget(nextSelection.target);
    const channelId = await prompts.select<string | typeof BACK>({
      message: `Channel on ${nextSelection.target.name}`,
      choices: [
        ...refreshedChannels.map((channel) => ({
          name: configuredChannelLabel(channel),
          value: channel.id,
        })),
        { name: '← Back', value: BACK },
      ],
    });
    if (channelId === BACK) {
      return changed ? nextManifest : null;
    }

    const channelUpdate = await editChannelMembers({
      manifest: nextManifest,
      manifestPath,
      selection: nextSelection,
      channelId,
      prompts,
    });
    if (!channelUpdate) {
      continue;
    }
    nextManifest = channelUpdate.manifest;
    nextSelection = channelUpdate.selection;
    changed = true;
  }
}

type TargetChannelEditState = {
  readonly manifest: PortfolioManifest;
  readonly selection: TargetSelection;
};

async function editChannelMembers(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly selection: TargetSelection;
  readonly channelId: string;
  readonly prompts: PortfolioPromptApi;
}): Promise<TargetChannelEditState | null> {
  let state: TargetChannelEditState = {
    manifest: input.manifest,
    selection: input.selection,
  };
  let changed = false;

  for (;;) {
    const step = await applyChannelMemberStep({
      ...state,
      manifestPath: input.manifestPath,
      channelId: input.channelId,
      prompts: input.prompts,
    });
    if (step === 'back') {
      return changed ? state : null;
    }
    if (step === 'missing') {
      console.log(`Channel ${input.channelId} is no longer configured on this target.`);
      return changed ? state : null;
    }
    if (step) {
      state = step;
      changed = true;
    }
  }
}

async function applyChannelMemberStep(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly selection: TargetSelection;
  readonly channelId: string;
  readonly prompts: PortfolioPromptApi;
}): Promise<TargetChannelEditState | 'back' | 'missing' | null> {
  const channel = overrideChannelsFromTarget(input.selection.target).find(
    (item) => item.id === input.channelId,
  );
  if (!channel) {
    return 'missing';
  }

  const members = channel.users ?? [];
  printChannelMembers(channel, members);
  const action = await input.prompts.select<'add' | 'remove' | typeof BACK>({
    message: `Members for ${configuredChannelLabel(channel)}`,
    choices: [
      { name: 'Add member', value: 'add' },
      {
        name: 'Remove members',
        value: 'remove',
        disabled: members.length === 0,
      },
      { name: '← Back', value: BACK },
    ],
  });
  if (action === BACK) {
    return 'back';
  }
  if (action === 'remove') {
    return removeChannelMembers(input.manifest, input.selection, input.channelId, input.prompts);
  }
  return addChannelMember(
    input.manifest,
    input.manifestPath,
    input.selection,
    channel,
    input.prompts,
  );
}

async function removeChannelMembers(
  manifest: PortfolioManifest,
  selection: TargetSelection,
  channelId: string,
  prompts: PortfolioPromptApi,
): Promise<{ readonly manifest: PortfolioManifest; readonly selection: TargetSelection } | null> {
  const channel = overrideChannelsFromTarget(selection.target).find(
    (item) => item.id === channelId,
  );
  const members = channel?.users ?? [];
  if (members.length === 0) {
    return null;
  }
  const removeIds = await prompts.checkbox({
    message: 'Select members to remove',
    choices: members.map((user) => ({
      name: configuredUserLabel(user),
      value: user.id,
      checked: false,
    })),
  });
  if (removeIds.length === 0) {
    return null;
  }
  const nextManifest = updateTargetChannels(
    manifest,
    selection.analysis.id,
    selection.target.id,
    (channels) =>
      channels.map((item) =>
        item.id === channelId
          ? withChannelUsers(
              item,
              (item.users ?? []).filter((user) => !removeIds.includes(user.id)),
            )
          : item,
      ),
  );
  return {
    manifest: nextManifest,
    selection: refreshTargetSelection(nextManifest, selection) ?? selection,
  };
}

async function addChannelMember(
  manifest: PortfolioManifest,
  manifestPath: string,
  selection: TargetSelection,
  channel: ChannelConfig,
  prompts: PortfolioPromptApi,
): Promise<{ readonly manifest: PortfolioManifest; readonly selection: TargetSelection } | null> {
  const directory = await loadTargetDirectory(
    manifest,
    manifestPath,
    selection.analysis,
    selection.target,
  );
  const added = await promptAddConfiguredUser({
    prompts,
    directory,
    channelId: channel.id,
    existingUserIds: new Set((channel.users ?? []).map((user) => user.id)),
    knownRoles: collectKnownRoles([
      ...overrideChannelsFromTarget(selection.target),
      ...collectSiblingTargetChannels(selection.analysis, selection.target.id),
    ]),
  });
  if (!added) {
    return null;
  }
  const nextManifest = updateTargetChannels(
    manifest,
    selection.analysis.id,
    selection.target.id,
    (channels) =>
      channels.map((item) =>
        item.id === channel.id ? withChannelUsers(item, [...(item.users ?? []), added]) : item,
      ),
  );
  return {
    manifest: nextManifest,
    selection: refreshTargetSelection(nextManifest, selection) ?? selection,
  };
}

async function moveMemberBetweenTargets(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const source = await selectTarget(manifest, prompts, {
    message: 'Source target',
  });
  if (!source) {
    return null;
  }

  const sourceMembers = collectTargetMembers(source.target);
  if (sourceMembers.length === 0) {
    console.log(
      `Target ${source.target.id} has no configured members to move. Add members on a channel first.`,
    );
    return null;
  }

  const member = await selectConfiguredUser(prompts, sourceMembers, 'Member to move');
  if (!member) {
    return null;
  }

  const destination = await selectTarget(manifest, prompts, {
    message: 'Destination target',
    exclude: [{ analysisId: source.analysis.id, targetId: source.target.id }],
  });
  if (!destination) {
    return null;
  }

  const sourceChannels = overrideChannelsFromTarget(source.target);
  const destinationChannels = overrideChannelsFromTarget(destination.target);
  if (destinationChannels.length === 0) {
    console.log(
      `Destination target ${destination.target.id} has no channel overrides. Add channels first.`,
    );
    return null;
  }

  const sourceChannelCount = sourceChannels.filter((channel) =>
    (channel.users ?? []).some((user) => user.id === member.id),
  ).length;
  const destinationChannelCount = destinationChannels.length;
  const alreadyOnDestination = destinationChannels.filter((channel) =>
    (channel.users ?? []).some((user) => user.id === member.id),
  ).length;

  const confirmed = await prompts.confirm({
    message: `Move ${configuredUserLabel(member)} from ${source.target.name} (${sourceChannelCount} channel${
      sourceChannelCount === 1 ? '' : 's'
    }) to ${destination.target.name} (${destinationChannelCount} channel${
      destinationChannelCount === 1 ? '' : 's'
    }${alreadyOnDestination > 0 ? `, already on ${alreadyOnDestination}` : ''})?`,
    default: true,
  });
  if (!confirmed) {
    return null;
  }

  const nextManifest = applyMemberMove({
    manifest,
    sourceAnalysisId: source.analysis.id,
    sourceTargetId: source.target.id,
    destinationAnalysisId: destination.analysis.id,
    destinationTargetId: destination.target.id,
    member,
  });
  console.log(
    `Moved ${configuredUserLabel(member)} from ${source.analysis.id}/${source.target.id} to ${destination.analysis.id}/${destination.target.id}.`,
  );
  return nextManifest;
}

export function applyMemberMove(input: {
  readonly manifest: PortfolioManifest;
  readonly sourceAnalysisId: string;
  readonly sourceTargetId: string;
  readonly destinationAnalysisId: string;
  readonly destinationTargetId: string;
  readonly member: ConfiguredUser;
}): PortfolioManifest {
  const withoutOnSource = updateTargetChannels(
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
    withoutOnSource,
    input.destinationAnalysisId,
    input.destinationTargetId,
    (channels) =>
      channels.map((channel) => {
        const existing = channel.users ?? [];
        if (existing.some((user) => user.id === input.member.id)) {
          return channel;
        }
        return withChannelUsers(channel, [...existing, input.member]);
      }),
  );
}

async function setTargetStatus(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
  now: Date,
): Promise<PortfolioManifest | null> {
  const selection = await selectTarget(manifest, prompts);
  if (!selection) {
    return null;
  }
  const status = await prompts.select<PortfolioTarget['status']>({
    message: `Status for ${selection.target.name}`,
    choices: [
      { name: 'active', value: 'active' },
      { name: 'paused', value: 'paused' },
      { name: 'archived', value: 'archived' },
    ],
    default: selection.target.status,
  });
  if (status === 'archived') {
    const endedOn = await prompts.input({
      message: 'Archive endedOn date',
      default: localDateForBackup(now),
      required: true,
    });
    const archiveReason = await prompts.input({
      message: 'Archive reason',
      default: selection.target.archiveReason,
    });
    return updateTarget(manifest, selection.analysis.id, selection.target.id, (target) => ({
      ...target,
      status,
      endedOn,
      ...(archiveReason ? { archiveReason } : {}),
    }));
  }

  return updateTarget(manifest, selection.analysis.id, selection.target.id, (target) => {
    const { endedOn: _endedOn, archiveReason: _archiveReason, ...rest } = target;
    return {
      ...rest,
      status,
    };
  });
}

async function addRun(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const analysis = await selectAnalysis(manifest, prompts);
  if (!analysis) {
    return null;
  }
  const run: PortfolioRun = {
    id: await promptSlug(prompts, 'Run id'),
    schedule: await promptSchedule(prompts),
    window: await promptWindow(prompts),
  };
  ensureUnusedId(analysis.runs ?? [], run.id, 'run');
  return updateAnalysis(manifest, analysis.id, (value) => ({
    ...value,
    runs: [...(value.runs ?? []), run],
  }));
}

async function addRollup(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const analysis = await selectAnalysis(manifest, prompts);
  if (!analysis) {
    return null;
  }
  const rollup: PortfolioRollup = {
    id: await promptSlug(prompts, 'Rollup id'),
    schedule: await promptSchedule(prompts),
    window: await promptWindow(prompts),
    prompt: await promptRequired(prompts, 'Rollup prompt path'),
  };
  ensureUnusedId(analysis.rollups ?? [], rollup.id, 'rollup');
  return updateAnalysis(manifest, analysis.id, (value) => ({
    ...value,
    rollups: [...(value.rollups ?? []), rollup],
  }));
}

async function addMaintenance(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const analysis = await selectAnalysis(manifest, prompts);
  if (!analysis) {
    return null;
  }
  const keepRuns = await prompts.number({
    message: 'keepRuns',
    default: 20,
    min: 1,
    required: true,
  });
  const maintenance: PortfolioMaintenance = {
    id: await promptSlug(prompts, 'Maintenance id'),
    kind: 'compact-state',
    schedule: await promptSchedule(prompts),
    keepRuns,
    backup: await prompts.confirm({
      message: 'Create compact-state backup?',
      default: true,
    }),
  };
  ensureUnusedId(analysis.maintenance ?? [], maintenance.id, 'maintenance');
  return updateAnalysis(manifest, analysis.id, (value) => ({
    ...value,
    maintenance: [...(value.maintenance ?? []), maintenance],
  }));
}

async function editNotifications(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const scope = await prompts.select<'defaults' | 'analysis' | 'target' | typeof BACK>({
    message: 'Notification config scope',
    choices: [
      { name: 'Portfolio defaults', value: 'defaults' },
      { name: 'Analysis defaults', value: 'analysis', disabled: manifest.analyses.length === 0 },
      {
        name: 'Target override',
        value: 'target',
        disabled: !manifest.analyses.some((analysis) => analysis.targets.length > 0),
      },
      { name: '← Back to main menu', value: BACK },
    ],
  });
  if (scope === BACK) {
    return null;
  }

  const mode = await prompts.select<'guided' | 'json' | typeof BACK>({
    message: 'Notification config editor',
    choices: [
      { name: 'Guided transport setup', value: 'guided' },
      { name: 'Edit raw JSON', value: 'json' },
      { name: '← Back', value: BACK },
    ],
  });
  if (mode === BACK) {
    return null;
  }

  if (scope === 'defaults') {
    return editDefaultNotifications(manifest, prompts, mode);
  }
  if (scope === 'analysis') {
    return editAnalysisNotifications(manifest, prompts, mode);
  }
  return editTargetNotifications(manifest, prompts, mode);
}

async function editDefaultNotifications(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
  mode: 'guided' | 'json',
): Promise<PortfolioManifest | null> {
  const runAndNotifyConfig = await promptRunAndNotifyConfigForScope(prompts, {
    mode,
    initial: manifest.defaults?.runAndNotifyConfig ?? {},
    scope: 'defaults',
  });
  if (!runAndNotifyConfig) {
    return null;
  }
  return {
    ...manifest,
    defaults: {
      ...(manifest.defaults ?? {}),
      runAndNotifyConfig,
    },
  };
}

async function editAnalysisNotifications(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
  mode: 'guided' | 'json',
): Promise<PortfolioManifest | null> {
  const analysis = await selectAnalysis(manifest, prompts);
  if (!analysis) {
    return null;
  }
  const runAndNotifyConfig = await promptRunAndNotifyConfigForScope(prompts, {
    mode,
    initial: analysis.defaults?.runAndNotifyConfig ?? {},
    scope: 'override',
  });
  if (!runAndNotifyConfig) {
    return null;
  }
  return updateAnalysis(manifest, analysis.id, (value) => ({
    ...value,
    defaults: {
      ...(value.defaults ?? {}),
      runAndNotifyConfig,
    },
  }));
}

async function editTargetNotifications(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
  mode: 'guided' | 'json',
): Promise<PortfolioManifest | null> {
  const selection = await selectTarget(manifest, prompts);
  if (!selection) {
    return null;
  }
  const runAndNotifyConfig = await promptRunAndNotifyConfigForScope(prompts, {
    mode,
    initial: selection.target.runAndNotifyConfig ?? {},
    defaultName: selection.target.name,
    scope: 'override',
  });
  if (!runAndNotifyConfig) {
    return null;
  }
  return updateTarget(manifest, selection.analysis.id, selection.target.id, (target) =>
    applyTargetRunAndNotifyConfig(target, runAndNotifyConfig),
  );
}

async function editTargetChannels(
  manifest: PortfolioManifest,
  manifestPath: string,
  prompts: PortfolioPromptApi,
  generateText: GenerateModelText,
): Promise<PortfolioManifest | null> {
  const selection = await selectTarget(manifest, prompts);
  if (!selection) {
    return null;
  }
  const config = await promptPortfolioTargetConfig({
    manifest,
    manifestPath,
    analysis: selection.analysis,
    target: selection.target,
    prompts,
    generateText,
    mode: 'channels',
  });
  if (!config) {
    return null;
  }
  return updateTarget(manifest, selection.analysis.id, selection.target.id, (target) => ({
    ...target,
    analysisConfig: config,
  }));
}

async function editTargetModel(
  manifest: PortfolioManifest,
  manifestPath: string,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const selection = await selectTarget(manifest, prompts);
  if (!selection) {
    return null;
  }
  const config = await promptPortfolioTargetConfig({
    manifest,
    manifestPath,
    analysis: selection.analysis,
    target: selection.target,
    prompts,
    generateText: generateModelText,
    mode: 'model',
  });
  if (!config) {
    return null;
  }
  return updateTarget(manifest, selection.analysis.id, selection.target.id, (target) => ({
    ...target,
    analysisConfig: config,
  }));
}

async function editTargetScoredDefaults(
  manifest: PortfolioManifest,
  manifestPath: string,
  prompts: PortfolioPromptApi,
): Promise<PortfolioManifest | null> {
  const selection = await selectTarget(manifest, prompts);
  if (!selection) {
    return null;
  }
  const config = await promptPortfolioTargetConfig({
    manifest,
    manifestPath,
    analysis: selection.analysis,
    target: selection.target,
    prompts,
    generateText: generateModelText,
    mode: 'scored-defaults',
  });
  if (!config) {
    return null;
  }
  return updateTarget(manifest, selection.analysis.id, selection.target.id, (target) => ({
    ...target,
    analysisConfig: config,
  }));
}

async function promptTarget(
  manifest: PortfolioManifest,
  analysis: PortfolioAnalysis,
  manifestPath: string,
  prompts: PortfolioPromptApi,
  generateText: GenerateModelText,
): Promise<PortfolioTarget> {
  const target: PortfolioTarget = {
    id: await promptSlug(prompts, 'Target id'),
    name: await promptRequired(prompts, 'Target name'),
    status: 'active',
  };
  if (
    (await canUseGuidedTargetConfig(manifest, analysis, manifestPath, target)) &&
    (await prompts.confirm({
      message: 'Use guided target analysis config setup?',
      default: true,
    }))
  ) {
    const analysisConfig = await promptPortfolioTargetConfig({
      manifest,
      manifestPath,
      analysis,
      target,
      prompts,
      generateText,
      mode: 'all',
    });
    const withAnalysisConfig = {
      ...target,
      ...(analysisConfig && Object.keys(analysisConfig).length > 0 ? { analysisConfig } : {}),
    };
    return promptTargetRunAndNotifyConfig(withAnalysisConfig, prompts);
  }
  if (
    await prompts.confirm({
      message: 'Add target analysisConfig JSON override?',
      default: true,
    })
  ) {
    const analysisConfig = await promptJsonObject(prompts, {
      message: `analysisConfig JSON for ${target.id}`,
      initial: { channels: [{ id: 'C_TARGET' }] },
    });
    if (!analysisConfig) {
      return target;
    }
    return promptTargetRunAndNotifyConfig({ ...target, analysisConfig }, prompts);
  }
  return promptTargetRunAndNotifyConfig(target, prompts);
}

async function promptTargetRunAndNotifyConfig(
  target: PortfolioTarget,
  prompts: PortfolioPromptApi,
): Promise<PortfolioTarget> {
  if (
    !(await prompts.confirm({
      message: 'Add runAndNotifyConfig for this target?',
      default: true,
    }))
  ) {
    return target;
  }
  const runAndNotifyConfig = await promptRunAndNotifyConfig(prompts, {
    initial: target.runAndNotifyConfig ?? {},
    defaultName: target.name,
    scope: 'override',
  });
  return applyTargetRunAndNotifyConfig(target, runAndNotifyConfig ?? undefined);
}

function applyTargetRunAndNotifyConfig(
  target: PortfolioTarget,
  runAndNotifyConfig: JsonObject | undefined,
): PortfolioTarget {
  if (!runAndNotifyConfig) {
    const { runAndNotifyConfig: _removed, ...rest } = target;
    return rest;
  }
  return {
    ...target,
    runAndNotifyConfig,
  };
}

async function canUseGuidedTargetConfig(
  manifest: PortfolioManifest,
  analysis: PortfolioAnalysis,
  manifestPath: string,
  target: PortfolioTarget,
): Promise<boolean> {
  try {
    await materializeEditableTargetConfig({ manifest, manifestPath, analysis, target });
    return true;
  } catch {
    return false;
  }
}

async function promptPortfolioTargetConfig(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly analysis: PortfolioAnalysis;
  readonly target: PortfolioTarget;
  readonly prompts: PortfolioPromptApi;
  readonly generateText: GenerateModelText;
  readonly mode: 'all' | 'channels' | 'model' | 'scored-defaults';
}): Promise<JsonObject | null> {
  const targetExists = input.analysis.targets.some((item) => item.id === input.target.id);
  if (
    targetExists &&
    input.mode === 'channels' &&
    !(await input.prompts.confirm({
      message: `Edit channels for ${input.target.name}?`,
      default: true,
    }))
  ) {
    return null;
  }

  const materialized = await materializeEditableTargetConfig(input);
  const promptApi = input.prompts as PromptApi;
  const currentOverride = input.target.analysisConfig ?? {};
  let nextOverride: JsonObject = { ...currentOverride };
  const overrideChannels = overrideChannelsFromTarget(input.target);
  const siblingChannels = collectSiblingTargetChannels(input.analysis, input.target.id);
  const channelsForCopySource = siblingChannels.length > 0 ? siblingChannels : overrideChannels;
  const channelReferenceConfig: AppConfig = {
    ...materialized.config,
    channels: overrideChannels,
  };
  const channelCopySourceConfig: AppConfig = {
    ...materialized.config,
    channels: channelsForCopySource,
  };

  if (input.mode === 'all' || input.mode === 'channels') {
    const directory = readDirectory(materialized.resolved, [
      ...(materialized.config.channels ?? []),
      ...overrideChannels,
      ...siblingChannels,
    ]);
    const channels = await promptForChannels(
      channelReferenceConfig,
      directory,
      promptApi,
      input.generateText,
      channelCopySourceConfig,
    );
    nextOverride = {
      ...nextOverride,
      channels: channels.length > 0 ? channels : undefined,
    };
  }

  if (
    input.mode === 'model' ||
    (input.mode === 'all' &&
      (await input.prompts.confirm({
        message: 'Customize target model override?',
        default: false,
      })))
  ) {
    nextOverride = {
      ...nextOverride,
      model: await promptForModel(materialized.config, promptApi),
    };
  }

  if (
    input.mode === 'scored-defaults' ||
    (input.mode === 'all' &&
      (await input.prompts.confirm({
        message: 'Customize target scored matcher defaults?',
        default: false,
      })))
  ) {
    nextOverride = {
      ...nextOverride,
      scoredMatcherDefaults: await promptForProviderScoringDefaults(
        materialized.config.scoredMatcherDefaults,
        promptApi,
        'target scored matcher defaults',
      ),
    };
  }

  return stripUndefinedObject(nextOverride);
}

async function materializeEditableTargetConfig(input: {
  readonly manifest: PortfolioManifest;
  readonly manifestPath: string;
  readonly analysis: PortfolioAnalysis;
  readonly target: PortfolioTarget;
}): Promise<{ readonly config: AppConfig; readonly resolved: ResolvedConfig }> {
  const manifestWithTarget = ensureTargetPresent(input.manifest, input.analysis.id, input.target);
  const config = materializeAnalysisConfig({
    manifest: manifestWithTarget,
    analysisId: input.analysis.id,
    targetId: input.target.id,
    configPathForValidation: input.manifestPath,
  });
  const resolvedConfig = await resolveConfigPaths(
    config,
    input.manifestPath || 'portfolio config wizard',
  );
  return {
    config,
    resolved: {
      config: resolvedConfig,
      configPath: input.manifestPath,
      configHash: hashJson(config),
      topicId: `${input.analysis.id}-${input.target.id}`,
    },
  };
}

function ensureTargetPresent(
  manifest: PortfolioManifest,
  analysisId: string,
  target: PortfolioTarget,
): PortfolioManifest {
  return updateAnalysis(manifest, analysisId, (analysis) => {
    if (analysis.targets.some((item) => item.id === target.id)) {
      return analysis;
    }
    return {
      ...analysis,
      targets: [...analysis.targets, target],
    };
  });
}

function stripUndefinedObject(input: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function refreshTargetSelection(
  manifest: PortfolioManifest,
  selection: TargetSelection,
): TargetSelection | null {
  const analysis = manifest.analyses.find((item) => item.id === selection.analysis.id);
  const target = analysis?.targets.find((item) => item.id === selection.target.id);
  if (!analysis || !target) {
    return null;
  }
  return { analysis, target };
}

function overrideChannelsFromTarget(target: PortfolioTarget): readonly ChannelConfig[] {
  const channels = readJsonArray(target.analysisConfig, 'channels');
  return channels.filter(isChannelConfig);
}

function collectSiblingTargetChannels(
  analysis: PortfolioAnalysis,
  excludeTargetId: string,
): readonly ChannelConfig[] {
  const channels: ChannelConfig[] = [];
  for (const target of analysis.targets) {
    if (target.id === excludeTargetId) {
      continue;
    }
    channels.push(...overrideChannelsFromTarget(target));
  }
  return channels;
}

function isChannelConfig(value: unknown): value is ChannelConfig {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'id' in value);
}

function isConfiguredUser(value: unknown): value is ConfiguredUser {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'id' in value &&
      typeof (value as { id?: unknown }).id === 'string',
  );
}

function collectTargetMembers(target: PortfolioTarget): readonly ConfiguredUser[] {
  const byId = new Map<string, ConfiguredUser>();
  for (const channel of overrideChannelsFromTarget(target)) {
    for (const user of channel.users ?? []) {
      if (!isConfiguredUser(user) || byId.has(user.id)) {
        continue;
      }
      byId.set(user.id, user);
    }
  }
  return [...byId.values()].toSorted((left, right) =>
    configuredUserLabel(left).localeCompare(configuredUserLabel(right)),
  );
}

function collectKnownRoles(channels: readonly ChannelConfig[]): Set<string> {
  return new Set(
    channels.flatMap((channel) =>
      (channel.users ?? [])
        .map((user) => user.role)
        .filter((role): role is string => role !== undefined && role.length > 0),
    ),
  );
}

function withChannelUsers(channel: ChannelConfig, users: readonly ConfiguredUser[]): ChannelConfig {
  const { users: _removed, ...rest } = channel;
  if (users.length === 0) {
    return rest;
  }
  return {
    ...rest,
    users,
  };
}

function updateTargetChannels(
  manifest: PortfolioManifest,
  analysisId: string,
  targetId: string,
  update: (channels: readonly ChannelConfig[]) => readonly ChannelConfig[],
): PortfolioManifest {
  return updateTarget(manifest, analysisId, targetId, (target) => {
    const nextChannels = update(overrideChannelsFromTarget(target));
    const currentOverride = target.analysisConfig ?? {};
    const analysisConfig = stripUndefinedObject({
      ...currentOverride,
      channels: nextChannels.length > 0 ? nextChannels : undefined,
    });
    if (Object.keys(analysisConfig).length === 0) {
      const { analysisConfig: _removed, ...rest } = target;
      return rest;
    }
    return {
      ...target,
      analysisConfig,
    };
  });
}

function configuredChannelLabel(channel: ChannelConfig): string {
  return channel.name ? `#${channel.name} (${channel.id})` : channel.id;
}

function configuredUserLabel(user: ConfiguredUser): string {
  const base = user.name ? `${user.name} (${user.id})` : user.id;
  return user.role ? `${base} [${user.role}]` : base;
}

function printChannelMembers(channel: ChannelConfig, members: readonly ConfiguredUser[]): void {
  if (members.length === 0) {
    console.log(`${configuredChannelLabel(channel)}: no members configured`);
    return;
  }
  console.log(
    `${configuredChannelLabel(channel)} members:\n${members
      .map((user) => `  - ${configuredUserLabel(user)}`)
      .join('\n')}`,
  );
}

async function loadTargetDirectory(
  manifest: PortfolioManifest,
  manifestPath: string,
  analysis: PortfolioAnalysis,
  target: PortfolioTarget,
): Promise<SlacrawlDirectory> {
  try {
    const materialized = await materializeEditableTargetConfig({
      manifest,
      manifestPath,
      analysis,
      target,
    });
    return readDirectory(materialized.resolved, [
      ...(materialized.config.channels ?? []),
      ...overrideChannelsFromTarget(target),
      ...collectSiblingTargetChannels(analysis, target.id),
    ]);
  } catch {
    const channels = overrideChannelsFromTarget(target);
    return {
      channels: channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        source: 'reference' as const,
      })),
      users: collectTargetMembers(target).map((user) => ({
        id: user.id,
        name: user.name,
        source: 'reference' as const,
      })),
      channelUserIds: new Map(
        channels.map((channel) => [channel.id, (channel.users ?? []).map((user) => user.id)]),
      ),
    };
  }
}

async function promptAddConfiguredUser(input: {
  readonly prompts: PortfolioPromptApi;
  readonly directory: SlacrawlDirectory;
  readonly channelId: string;
  readonly existingUserIds: ReadonlySet<string>;
  readonly knownRoles: ReadonlySet<string>;
}): Promise<ConfiguredUser | null> {
  const allowedIds = new Set(input.directory.channelUserIds.get(input.channelId) ?? []);
  const candidates =
    allowedIds.size > 0
      ? input.directory.users.filter((user) => allowedIds.has(user.id))
      : input.directory.users;
  const selectable = candidates.filter((user) => !input.existingUserIds.has(user.id));

  let selected: SlacrawlUserInfo | undefined;
  if (selectable.length > 0) {
    selected = await searchOptionalChoice(
      input.prompts,
      'Search user to add',
      selectable,
      userLabel,
      'Enter user id manually',
    );
  }

  let userId: string;
  let userName: string | undefined;
  if (selected) {
    userId = selected.id;
    userName = selected.name;
  } else {
    userId = (
      await input.prompts.input({
        message: 'User id to add',
        required: true,
      })
    ).trim();
    if (!userId || input.existingUserIds.has(userId)) {
      if (input.existingUserIds.has(userId)) {
        console.log(`User ${userId} is already configured on this channel.`);
      }
      return null;
    }
    const name = (
      await input.prompts.input({
        message: 'User display name (optional)',
      })
    ).trim();
    userName = name || undefined;
  }

  const role = await promptConfiguredUserRole(input.prompts, input.knownRoles, {
    id: userId,
    ...(userName ? { name: userName } : {}),
  });
  return {
    id: userId,
    ...(userName ? { name: userName } : {}),
    ...(role ? { role } : {}),
  };
}

async function selectConfiguredUser(
  prompts: PortfolioPromptApi,
  users: readonly ConfiguredUser[],
  message: string,
): Promise<ConfiguredUser | null> {
  const selectedId = await prompts.select<string | typeof BACK>({
    message,
    choices: [
      ...users.map((user) => ({
        name: configuredUserLabel(user),
        value: user.id,
      })),
      { name: '← Back', value: BACK },
    ],
  });
  if (selectedId === BACK) {
    return null;
  }
  return users.find((user) => user.id === selectedId) ?? null;
}

async function promptConfiguredUserRole(
  prompts: PortfolioPromptApi,
  knownRoles: ReadonlySet<string>,
  user: ConfiguredUser,
): Promise<string | undefined> {
  const choices = [
    ...[...knownRoles].toSorted().map((role) => ({ name: role, value: role })),
    { name: 'No role', value: '' },
    { name: 'Add new role', value: '__new__' },
  ];
  const role = await prompts.select({
    message: `Role for ${configuredUserLabel(user)}`,
    choices,
  });
  if (role === '__new__') {
    const added = await prompts.input({ message: 'New role label' });
    return added.trim() || undefined;
  }
  return role || undefined;
}

async function searchOptionalChoice<T>(
  prompts: PortfolioPromptApi,
  message: string,
  choices: readonly T[],
  label: (choice: T) => string,
  cancelLabel: string,
): Promise<T | undefined> {
  return prompts.search({
    message,
    source: (term) => {
      const needle = term?.toLowerCase().trim() ?? '';
      const found = choices
        .filter((choice) => needle.length === 0 || label(choice).toLowerCase().includes(needle))
        .map((choice) => ({ name: label(choice), value: choice }));
      return [...found, { name: cancelLabel, value: undefined }];
    },
  });
}

async function promptRunAndNotifyConfigForScope(
  prompts: PortfolioPromptApi,
  input: {
    readonly mode: 'guided' | 'json';
    readonly initial: JsonObject;
    readonly defaultName?: string | undefined;
    readonly scope: RunAndNotifyConfigScope;
  },
): Promise<JsonObject | null> {
  if (input.mode === 'json') {
    const raw = await promptJsonObject(prompts, {
      message: 'Edit runAndNotifyConfig JSON',
      initial: input.initial,
      allowBack: true,
    });
    if (!raw) {
      return null;
    }
    return finalizeRunAndNotifyConfig(raw, input.defaultName) ?? null;
  }
  return promptRunAndNotifyConfig(prompts, {
    initial: input.initial,
    defaultName: input.defaultName,
    scope: input.scope,
  });
}

async function promptRunAndNotifyConfig(
  prompts: PortfolioPromptApi,
  input: {
    readonly initial: JsonObject;
    readonly defaultName?: string | undefined;
    readonly scope: RunAndNotifyConfigScope;
  },
): Promise<JsonObject | null> {
  const initialName = readJsonString(input.initial, 'name') ?? input.defaultName ?? '';
  const name = await prompts.input({
    message: 'Notification name',
    default: initialName,
    required: true,
  });

  let result: JsonObject;
  if (input.scope === 'defaults') {
    const transports = await prompts.checkbox({
      message: 'Enable notification transports',
      choices: [
        { name: 'SMTP email', value: 'smtp' },
        { name: 'Slack', value: 'slack' },
      ],
      required: true,
    });
    if (transports.length === 0) {
      return null;
    }
    const built = await buildRunAndNotifyTransports(prompts, {
      scope: input.scope,
      selected: transports,
      initial: input.initial,
    });
    if (!built) {
      return null;
    }
    result = stripUndefinedObject({
      ...input.initial,
      name,
      transports: built,
    });
  } else {
    const built = await buildRunAndNotifyTransports(prompts, {
      scope: input.scope,
      initial: input.initial,
    });
    if (built === null) {
      return null;
    }
    result = stripUndefinedObject({
      ...input.initial,
      name,
      ...(Object.keys(built).length > 0 ? { transports: built } : {}),
    });
  }

  return finalizeRunAndNotifyConfig(result, input.defaultName) ?? null;
}

async function buildRunAndNotifyTransports(
  prompts: PortfolioPromptApi,
  input: {
    readonly scope: RunAndNotifyConfigScope;
    readonly initial: JsonObject;
    readonly selected?: readonly string[] | undefined;
  },
): Promise<JsonObject | null> {
  const initialTransports = readTransports(input.initial);
  if (input.scope === 'defaults') {
    return buildDefaultRunAndNotifyTransports(prompts, initialTransports, input.selected ?? []);
  }
  return buildOverrideRunAndNotifyTransports(prompts, initialTransports);
}

async function buildDefaultRunAndNotifyTransports(
  prompts: PortfolioPromptApi,
  initialTransports: ReturnType<typeof readTransports>,
  selected: readonly string[],
): Promise<JsonObject | null> {
  const nextTransports: JsonObject = {};
  if (selected.includes('smtp')) {
    const smtp = await promptSmtpTransport(prompts, initialTransports.smtp);
    if (!smtp) {
      return null;
    }
    setJsonObjectProperty(nextTransports, 'smtp', smtp);
  }
  if (selected.includes('slack')) {
    const slack = await promptSlackTransport(prompts, initialTransports.slack);
    if (!slack) {
      return null;
    }
    setJsonObjectProperty(nextTransports, 'slack', slack);
  }
  return nextTransports;
}

async function buildOverrideRunAndNotifyTransports(
  prompts: PortfolioPromptApi,
  initialTransports: ReturnType<typeof readTransports>,
): Promise<JsonObject | null> {
  const nextTransports: JsonObject = {};
  const hadSlack = Object.keys(initialTransports.slack ?? {}).length > 0;
  if (
    await prompts.confirm({
      message: 'Configure SMTP to addresses?',
      default: true,
    })
  ) {
    const smtp = await promptSmtpTransportOverride(prompts, initialTransports.smtp);
    if (!smtp) {
      return null;
    }
    setJsonObjectProperty(nextTransports, 'smtp', smtp);
  }
  if (
    await prompts.confirm({
      message: 'Configure Slack channel override?',
      default: hadSlack,
    })
  ) {
    const slack = await promptSlackTransportOverride(prompts, initialTransports.slack);
    if (!slack) {
      return null;
    }
    setJsonObjectProperty(nextTransports, 'slack', slack);
  }
  return nextTransports;
}

function finalizeRunAndNotifyConfig(
  config: JsonObject,
  defaultName: string | undefined,
): JsonObject | undefined {
  let next = { ...config };
  const name = readJsonString(next, 'name');
  if (defaultName !== undefined && (name === undefined || name === defaultName)) {
    next = omitJsonKey(next, 'name');
  }
  const transports = readJsonObject(readJsonValue(next, 'transports'));
  if (Object.keys(transports).length === 0) {
    next = omitJsonKey(next, 'transports');
  }
  if (Object.keys(next).length === 0) {
    return undefined;
  }
  return next;
}

function omitJsonKey(object: JsonObject, key: string): JsonObject {
  const next: JsonObject = {};
  for (const [entryKey, value] of Object.entries(object)) {
    if (entryKey !== key) {
      next[entryKey] = value;
    }
  }
  return next;
}

async function promptSmtpTransportOverride(
  prompts: PortfolioPromptApi,
  initial: JsonObject | undefined,
): Promise<JsonObject | null> {
  const to = (
    await prompts.input({
      message: 'SMTP to addresses (comma-separated)',
      default: readStringArray(readJsonValue(initial, 'to')).join(', '),
      required: true,
    })
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return { to };
}

async function promptSmtpTransport(
  prompts: PortfolioPromptApi,
  initial: JsonObject | undefined,
): Promise<JsonObject | null> {
  const initialAuth = readJsonObject(readJsonValue(initial, 'auth'));
  const host = await prompts.input({
    message: 'SMTP host',
    default: readJsonString(initial, 'host') ?? 'smtp.example.com',
    required: true,
  });
  const port = await prompts.number({
    message: 'SMTP port',
    default: readJsonNumber(initial, 'port') ?? 587,
    required: true,
  });
  if (port === undefined) {
    return null;
  }
  const secure = await prompts.confirm({
    message: 'Use TLS (secure)?',
    default: readJsonBoolean(initial, 'secure') ?? false,
  });
  const from = await prompts.input({
    message: 'SMTP from address',
    default: readJsonString(initial, 'from') ?? '',
    required: true,
  });
  const to = (
    await prompts.input({
      message: 'SMTP to addresses (comma-separated)',
      default: readStringArray(readJsonValue(initial, 'to')).join(', '),
      required: true,
    })
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const authUser = await prompts.input({
    message: 'SMTP auth user',
    default: readJsonString(initialAuth, 'user') ?? from,
  });
  const passEnvVar = await prompts.input({
    message: 'SMTP password environment variable',
    default: readJsonString(initialAuth, 'passEnvVar') ?? 'SMTP_PASS',
    required: true,
  });
  return {
    enabled: true,
    host,
    port,
    secure,
    from,
    to,
    auth: stripUndefinedObject({
      ...(authUser ? { user: authUser } : {}),
      passEnvVar,
    }),
  };
}

async function promptSlackTransport(
  prompts: PortfolioPromptApi,
  initial: JsonObject | undefined,
): Promise<JsonObject | null> {
  const tokenEnvVar = await prompts.input({
    message: 'Slack token environment variable',
    default: readJsonString(initial, 'tokenEnvVar') ?? 'SLACK_BOT_TOKEN',
    required: true,
  });
  const defaultChannel = await prompts.input({
    message: 'Slack default channel',
    default: readJsonString(initial, 'defaultChannel') ?? '#manager-reports',
    required: true,
  });
  const thread = await prompts.confirm({
    message: 'Post notifications in a thread?',
    default: readJsonBoolean(initial, 'thread') ?? false,
  });
  return {
    enabled: true,
    tokenEnvVar,
    defaultChannel,
    thread,
  };
}

async function promptSlackTransportOverride(
  prompts: PortfolioPromptApi,
  initial: JsonObject | undefined,
): Promise<JsonObject | null> {
  const defaultChannel = await prompts.input({
    message: 'Slack default channel override',
    default: readJsonString(initial, 'defaultChannel') ?? '#manager-reports',
    required: true,
  });
  const thread = await prompts.confirm({
    message: 'Post notifications in a thread?',
    default: readJsonBoolean(initial, 'thread') ?? false,
  });
  return stripUndefinedObject({
    enabled: true,
    defaultChannel,
    ...(thread ? { thread } : {}),
  });
}

function readTransports(initial: JsonObject): {
  readonly smtp: JsonObject | undefined;
  readonly slack: JsonObject | undefined;
} {
  const transports = readJsonObject(readJsonValue(initial, 'transports'));
  return {
    smtp: readJsonObject(readJsonValue(transports, 'smtp')),
    slack: readJsonObject(readJsonValue(transports, 'slack')),
  };
}

function readJsonValue(object: JsonObject | undefined, key: string): unknown {
  return object?.[key];
}

function readJsonString(object: JsonObject | undefined, key: string): string | undefined {
  const value = readJsonValue(object, key);
  return typeof value === 'string' ? value : undefined;
}

function readJsonNumber(object: JsonObject | undefined, key: string): number | undefined {
  const value = readJsonValue(object, key);
  return typeof value === 'number' ? value : undefined;
}

function readJsonBoolean(object: JsonObject | undefined, key: string): boolean | undefined {
  const value = readJsonValue(object, key);
  return typeof value === 'boolean' ? value : undefined;
}

function readJsonArray(object: JsonObject | undefined, key: string): readonly unknown[] {
  const value = readJsonValue(object, key);
  return Array.isArray(value) ? value : [];
}

function setJsonObjectProperty(object: JsonObject, key: string, value: unknown): void {
  object[key] = value;
}

function readJsonObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

async function promptSchedule(prompts: PortfolioPromptApi): Promise<JsonObject> {
  const kind = await prompts.select<string>({
    message: 'Schedule kind',
    choices: [
      { name: 'daily', value: 'daily' },
      { name: 'workdays', value: 'workdays' },
      { name: 'weekdays', value: 'weekdays' },
      { name: 'every-n-workdays', value: 'every-n-workdays' },
      { name: 'manual', value: 'manual' },
    ],
  });
  const schedule: {
    kind: string;
    weekdays?: string[] | undefined;
    everyWorkdays?: number | undefined;
    time?: string | undefined;
  } = { kind };
  if (kind === 'weekdays') {
    schedule.weekdays = (
      await prompts.input({
        message: 'Weekdays comma list',
        default: 'friday',
        required: true,
      })
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (kind === 'every-n-workdays') {
    const everyWorkdays = await prompts.number({
      message: 'Every how many workdays?',
      default: 5,
      min: 1,
      required: true,
    });
    if (everyWorkdays === undefined) {
      throw new Error('everyWorkdays is required');
    }
    schedule.everyWorkdays = everyWorkdays;
  }
  if (kind !== 'manual') {
    const time = await prompts.input({
      message: 'Local due time HH:MM',
      default: '22:00',
      required: true,
    });
    schedule.time = time;
  }
  return schedule;
}

async function promptWindow(prompts: PortfolioPromptApi): Promise<JsonObject> {
  const kind = await prompts.select<'date' | 'named' | 'range'>({
    message: 'Window type',
    choices: [
      { name: 'date alias', value: 'date' },
      { name: 'named window', value: 'named' },
      { name: 'explicit range', value: 'range' },
    ],
  });
  if (kind === 'date') {
    return {
      date: await prompts.input({
        message: 'Date alias or YYYY-MM-DD',
        default: 'today',
        required: true,
      }),
    };
  }
  if (kind === 'named') {
    return {
      name: await prompts.select<string>({
        message: 'Named window',
        choices: [
          { name: 'current-workday', value: 'current-workday' },
          { name: 'previous-workday', value: 'previous-workday' },
          { name: 'previous-5-workdays', value: 'previous-5-workdays' },
        ],
      }),
    };
  }
  return {
    startDate: await prompts.input({
      message: 'Start date YYYY-MM-DD',
      required: true,
    }),
    endDate: await prompts.input({
      message: 'End date YYYY-MM-DD',
      required: true,
    }),
  };
}

async function promptJsonObject(
  prompts: PortfolioPromptApi,
  input: {
    readonly message: string;
    readonly initial: JsonObject;
    readonly allowBack?: boolean | undefined;
  },
): Promise<JsonObject | null> {
  if (input.allowBack) {
    const proceed = await prompts.select<'edit' | typeof BACK>({
      message: input.message,
      choices: [
        { name: 'Edit JSON', value: 'edit' },
        { name: '← Back', value: BACK },
      ],
    });
    if (proceed === BACK) {
      return null;
    }
  }
  const value = await prompts.editor({
    message: input.message,
    default: JSON.stringify(input.initial, null, 2),
    postfix: '.json',
  });
  return parseJsonObject(value, input.message);
}

async function promptSlug(prompts: PortfolioPromptApi, message: string): Promise<string> {
  const value = await promptRequired(prompts, message);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`${message} must be a lowercase slug`);
  }
  return value;
}

async function promptRequired(prompts: PortfolioPromptApi, message: string): Promise<string> {
  return prompts.input({
    message,
    required: true,
  });
}

async function selectAnalysis(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
): Promise<PortfolioAnalysis | null> {
  if (manifest.analyses.length === 0) {
    throw new Error('No analyses configured');
  }
  const analysisId = await prompts.select<string | typeof BACK>({
    message: 'Analysis',
    choices: [
      ...manifest.analyses.map((analysis) => ({
        name: `${analysis.name} (${analysis.id})`,
        value: analysis.id,
      })),
      { name: '← Back', value: BACK },
    ],
  });
  if (analysisId === BACK) {
    return null;
  }
  const selected = manifest.analyses.find((analysis) => analysis.id === analysisId);
  if (!selected) {
    throw new Error(`Unknown analysis: ${analysisId}`);
  }
  return selected;
}

async function selectTarget(
  manifest: PortfolioManifest,
  prompts: PortfolioPromptApi,
  options: {
    readonly message?: string | undefined;
    readonly exclude?: readonly { readonly analysisId: string; readonly targetId: string }[];
  } = {},
): Promise<TargetSelection | null> {
  const excluded = new Set(
    (options.exclude ?? []).map((item) => `${item.analysisId}\u0000${item.targetId}`),
  );
  const targets = manifest.analyses.flatMap((analysis) =>
    analysis.targets
      .filter((target) => !excluded.has(`${analysis.id}\u0000${target.id}`))
      .map((target) => ({
        analysis,
        target,
      })),
  );
  if (targets.length === 0) {
    if ((options.exclude ?? []).length > 0) {
      console.log('No other targets available.');
      return null;
    }
    throw new Error('No targets configured');
  }
  const key = await prompts.select<string | typeof BACK>({
    message: options.message ?? 'Target',
    choices: [
      ...targets.map(({ analysis, target }) => ({
        name: `${analysis.id}/${target.id} - ${target.name} [${target.status}]`,
        value: `${analysis.id}\u0000${target.id}`,
      })),
      { name: '← Back', value: BACK },
    ],
  });
  if (key === BACK) {
    return null;
  }
  const [analysisId, targetId] = key.split('\u0000');
  const selected = targets.find(
    (candidate) => candidate.analysis.id === analysisId && candidate.target.id === targetId,
  );
  if (!selected) {
    throw new Error(`Unknown target: ${key}`);
  }
  return selected;
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

function updateTarget(
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

function ensureUnusedId(
  values: readonly { readonly id: string }[],
  id: string,
  label: string,
): void {
  if (values.some((value) => value.id === id)) {
    throw new Error(`Duplicate ${label} id: ${id}`);
  }
}

function printManifestSummary(manifest: PortfolioManifest): void {
  console.log(
    JSON.stringify(
      {
        analyses: manifest.analyses.map((analysis) => ({
          id: analysis.id,
          name: analysis.name,
          targets: analysis.targets.map((target) => ({
            id: target.id,
            name: target.name,
            status: target.status,
          })),
          runs: (analysis.runs ?? []).map((run) => run.id),
          rollups: (analysis.rollups ?? []).map((rollup) => rollup.id),
          maintenance: (analysis.maintenance ?? []).map((task) => task.id),
        })),
      },
      null,
      2,
    ),
  );
}

function printPreview(manifest: PortfolioManifest, manifestPath: string, now: Date): void {
  const localTimeZone = manifest.timezone ?? resolveLocalTimeZone();
  const plan = planPortfolioDryRun({
    manifest,
    manifestPath,
    manifestHash: hashJson(manifest),
    now,
    localTimeZone,
  });
  console.log(JSON.stringify(plan, null, 2));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function timestampForBackup(now: Date): string {
  return now
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
}

function localDateForBackup(now: Date): string {
  return now.toISOString().slice(0, 10);
}
