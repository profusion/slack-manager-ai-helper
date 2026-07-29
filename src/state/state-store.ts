import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import persistedStateSchema from '../../schemas/persisted-state.schema.json' with { type: 'json' };
import type { DateRange } from '../date-range.js';
import type { ModelUsage } from '../llm/generate.js';
import type { EvidenceMessage, ModelCallRecord } from '../types.js';

export type ExecutionMode = 'explicit' | 'implicit';

export type MemoryRecord = {
  readonly id: string;
  readonly topicId: string;
  readonly scope: string;
  readonly scopeId: string | null;
  readonly content: string;
  readonly contentType: string;
  readonly createdAt: string;
  readonly runId: string;
};

export type ModelOutputRecord = {
  readonly id: string;
  readonly runId: string;
  readonly topicId: string;
  readonly outputText: string;
  readonly reportText?: string;
  readonly outputJson?: unknown;
  readonly schemaValid?: boolean | null;
  readonly schemaErrors?: unknown;
  readonly modelProvider?: string;
  readonly modelName?: string;
  readonly modelAttempts?: number;
  readonly modelCalls?: readonly ModelCallRecord[];
  readonly usage?: ModelUsage;
  readonly createdAt: string;
};

export type EvidenceRecord = EvidenceMessage & {
  readonly id: string;
  readonly runId: string;
  readonly topicId: string;
};

export type RunRecord = {
  readonly id: string;
  readonly topicId: string;
  readonly configHash: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly errorMessage?: string;
  readonly executionMode: ExecutionMode;
  readonly requestedRange?: DateRange | undefined;
  readonly scanStartCursor: string | null;
  readonly scanEndCursor: string | null;
  readonly scanStartedAt: string;
  readonly scanEndedAt?: string | undefined;
  readonly inputMessageCount: number;
  readonly matchedMessageCount: number;
  readonly evidenceMessageCount: number;
  readonly modelCalled: boolean;
  readonly memories: readonly MemoryRecord[];
  readonly modelOutputs: readonly ModelOutputRecord[];
  readonly evidenceMessages: readonly EvidenceRecord[];
};

export type PersistedState = {
  readonly version: 'v1';
  readonly topicId: string;
  readonly runs: readonly RunRecord[];
};

export type StateStore = {
  readonly statePath: string;
  readonly state: PersistedState;
};

export type StateCounts = {
  readonly runs: number;
  readonly memories: number;
  readonly modelOutputs: number;
  readonly evidenceMessages: number;
};

export type CompactStateSummary = {
  readonly before: StateCounts;
  readonly after: StateCounts;
  readonly removed: StateCounts;
  readonly retainedRunIds: readonly string[];
};

export type RunWindow = {
  readonly executionMode: ExecutionMode;
  readonly requestedRange?: DateRange | undefined;
  readonly scanStartCursor: string | null;
  readonly scanEndCursor: string | null;
};

const ajv = new Ajv2020({ allErrors: true });
const validatePersistedState = ajv.compile(persistedStateSchema);

export function openStateStore(statePath: string, topicId: string): StateStore {
  const state = existsSync(statePath)
    ? readPersistedState(statePath)
    : createEmptyPersistedState(topicId);

  if (state.topicId !== topicId) {
    throw new Error(
      `State file ${statePath} belongs to topic "${state.topicId}", not "${topicId}"`,
    );
  }

  return {
    statePath,
    state,
  };
}

export function createRun(
  store: StateStore,
  input: {
    readonly id: string;
    readonly topicId: string;
    readonly configHash: string;
    readonly startedAt: string;
    readonly window: RunWindow;
  },
): StateStore {
  return updateStore(store, {
    ...store.state,
    runs: [
      ...store.state.runs,
      {
        id: input.id,
        topicId: input.topicId,
        configHash: input.configHash,
        startedAt: input.startedAt,
        status: 'running',
        executionMode: input.window.executionMode,
        ...(input.window.requestedRange ? { requestedRange: input.window.requestedRange } : {}),
        scanStartCursor: input.window.scanStartCursor,
        scanEndCursor: input.window.scanEndCursor,
        scanStartedAt: input.startedAt,
        inputMessageCount: 0,
        matchedMessageCount: 0,
        evidenceMessageCount: 0,
        modelCalled: false,
        memories: [],
        modelOutputs: [],
        evidenceMessages: [],
      },
    ],
  });
}

export function finishRun(
  store: StateStore,
  input: {
    readonly id: string;
    readonly finishedAt: string;
    readonly status: 'completed' | 'failed';
    readonly errorMessage?: string;
    readonly inputMessageCount: number;
    readonly matchedMessageCount: number;
    readonly evidenceMessageCount: number;
    readonly modelCalled: boolean;
  },
): StateStore {
  return updateRun(store, input.id, (run) => ({
    ...run,
    finishedAt: input.finishedAt,
    scanEndedAt: input.finishedAt,
    status: input.status,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    inputMessageCount: input.inputMessageCount,
    matchedMessageCount: input.matchedMessageCount,
    evidenceMessageCount: input.evidenceMessageCount,
    modelCalled: input.modelCalled,
  }));
}

export function readPreviousMemory(store: StateStore, window: RunWindow): string | null {
  const run = findPreviousMemoryRun(store.state.runs, window);
  return (
    run?.memories
      .filter((memory) => memory.scope === 'global')
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.content ?? null
  );
}

export function latestSuccessfulImplicitRun(store: StateStore): RunRecord | null {
  return (
    store.state.runs.findLast(
      (run) =>
        run.status === 'completed' &&
        run.executionMode === 'implicit' &&
        run.scanEndCursor !== null,
    ) ?? null
  );
}

export function saveMemory(
  store: StateStore,
  input: {
    readonly id: string;
    readonly topicId: string;
    readonly content: string;
    readonly createdAt: string;
    readonly runId: string;
  },
): StateStore {
  return updateRun(store, input.runId, (run) => ({
    ...run,
    memories: [
      ...run.memories,
      {
        id: input.id,
        topicId: input.topicId,
        scope: 'global',
        scopeId: null,
        content: input.content,
        contentType: 'text',
        createdAt: input.createdAt,
        runId: input.runId,
      },
    ],
  }));
}

export function saveModelOutput(store: StateStore, input: SaveModelOutputInput): StateStore {
  return updateRun(store, input.runId, (run) => ({
    ...run,
    modelOutputs: [...run.modelOutputs, modelOutputRecord(input)],
  }));
}

type SaveModelOutputInput = {
  readonly id: string;
  readonly runId: string;
  readonly topicId: string;
  readonly outputText: string;
  readonly reportText?: string | undefined;
  readonly outputJson?: unknown;
  readonly schemaValid?: boolean | undefined;
  readonly schemaErrors?: unknown;
  readonly modelProvider?: string | undefined;
  readonly modelName?: string | undefined;
  readonly modelAttempts?: number | undefined;
  readonly modelCalls?: readonly ModelCallRecord[] | undefined;
  readonly usage?: ModelUsage | undefined;
  readonly createdAt: string;
};

function modelOutputRecord(input: SaveModelOutputInput): ModelOutputRecord {
  const record = addOptionalModelOutputFields(
    {
      id: input.id,
      runId: input.runId,
      topicId: input.topicId,
      outputText: input.outputText,
      schemaValid: input.schemaValid ?? null,
      createdAt: input.createdAt,
    },
    input,
  );
  if (input.reportText !== undefined) {
    return { ...record, reportText: input.reportText };
  }
  return record;
}

function addOptionalModelOutputFields(
  record: ModelOutputRecord,
  input: SaveModelOutputInput,
): ModelOutputRecord {
  return {
    ...record,
    ...(input.outputJson === undefined ? {} : { outputJson: input.outputJson }),
    ...(input.schemaErrors === undefined ? {} : { schemaErrors: input.schemaErrors }),
    ...(input.modelProvider === undefined ? {} : { modelProvider: input.modelProvider }),
    ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
    ...(input.modelAttempts === undefined ? {} : { modelAttempts: input.modelAttempts }),
    ...(input.modelCalls === undefined ? {} : { modelCalls: input.modelCalls }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  };
}

export function saveEvidenceMessages(
  store: StateStore,
  input: {
    readonly runId: string;
    readonly topicId: string;
    readonly messages: readonly EvidenceMessage[];
  },
): StateStore {
  return updateRun(store, input.runId, (run) => ({
    ...run,
    evidenceMessages: [
      ...run.evidenceMessages,
      ...input.messages.map((message, index) => ({
        ...message,
        id: `${input.runId}:${index}`,
        runId: input.runId,
        topicId: input.topicId,
      })),
    ],
  }));
}

export function flattenEvidenceMessages(state: PersistedState): readonly EvidenceRecord[] {
  return state.runs.flatMap((run) => run.evidenceMessages);
}

export function flattenModelOutputs(state: PersistedState): readonly ModelOutputRecord[] {
  return state.runs.flatMap((run) => run.modelOutputs);
}

export function flattenMemories(state: PersistedState): readonly MemoryRecord[] {
  return state.runs.flatMap((run) => run.memories);
}

export function compactState(
  store: StateStore,
  input: {
    readonly keepRuns: number;
  },
): { readonly store: StateStore; readonly summary: CompactStateSummary } {
  validateKeepRuns(input.keepRuns);

  const before = countStateRecords(store.state);
  const retainedRuns = input.keepRuns === 0 ? [] : store.state.runs.slice(-input.keepRuns);
  const retainedRunIds = new Set(retainedRuns.map((run) => run.id));
  const latestMemoryRuns = latestMemoryBearingRunsByScope(store.state.runs);
  const retainedMemoryRunIds = new Set(latestMemoryRuns.map((run) => run.id));
  const compactedRuns = store.state.runs
    .filter((run) => retainedRunIds.has(run.id) || retainedMemoryRunIds.has(run.id))
    .map((run) =>
      retainedRunIds.has(run.id)
        ? run
        : {
            ...run,
            evidenceMessages: [],
            modelOutputs: [],
          },
    );

  const compactedState: PersistedState = {
    ...store.state,
    runs: compactedRuns,
  };
  const after = countStateRecords(compactedState);
  const updatedStore = updateStore(store, compactedState);

  return {
    store: updatedStore,
    summary: {
      before,
      after,
      removed: {
        runs: before.runs - after.runs,
        memories: before.memories - after.memories,
        modelOutputs: before.modelOutputs - after.modelOutputs,
        evidenceMessages: before.evidenceMessages - after.evidenceMessages,
      },
      retainedRunIds: [...retainedRunIds],
    },
  };
}

function findPreviousMemoryRun(runs: readonly RunRecord[], window: RunWindow): RunRecord | null {
  return (
    canonicalRuns(runs)
      .filter((run) => run.memories.length > 0)
      .filter((run) => run.status === 'completed')
      .filter((run) => run.scanEndCursor !== null)
      .filter((run) => isBeforeWindow(run, window))
      .toSorted((left, right) => compareRunEndThenFinished(right, left))[0] ?? null
  );
}

function canonicalRuns(runs: readonly RunRecord[]): readonly RunRecord[] {
  const latestByKey = new Map<string, RunRecord>();
  for (const run of runs) {
    if (run.status !== 'completed') {
      continue;
    }
    latestByKey.set(runRangeKey(run), run);
  }
  return [...latestByKey.values()];
}

function runRangeKey(run: RunRecord): string {
  return `${run.executionMode}:${JSON.stringify(run.requestedRange ?? {})}:${run.scanStartCursor ?? ''}:${run.scanEndCursor ?? ''}`;
}

function compareRunEndThenFinished(left: RunRecord, right: RunRecord): number {
  return (
    String(left.scanEndCursor ?? '').localeCompare(String(right.scanEndCursor ?? ''), undefined, {
      numeric: true,
    }) ||
    (left.finishedAt ?? left.startedAt).localeCompare(right.finishedAt ?? right.startedAt) ||
    left.id.localeCompare(right.id)
  );
}

function isBeforeWindow(run: RunRecord, window: RunWindow): boolean {
  if (run.scanEndCursor === null) {
    return false;
  }
  if (window.scanStartCursor !== null) {
    return Number(run.scanEndCursor) < Number(window.scanStartCursor);
  }
  if (window.scanEndCursor !== null) {
    return Number(run.scanEndCursor) < Number(window.scanEndCursor);
  }
  return false;
}

function latestMemoryBearingRunsByScope(runs: readonly RunRecord[]): readonly RunRecord[] {
  const latestByScope = new Map<string, RunRecord>();

  for (const run of runs) {
    if (run.status !== 'completed') {
      continue;
    }
    for (const memory of run.memories) {
      const key = `${memory.scope}\u0000${memory.scopeId ?? ''}`;
      latestByScope.set(key, run);
    }
  }

  return [...latestByScope.values()];
}

function readPersistedState(statePath: string): PersistedState {
  const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
  validateState(parsed, statePath);
  return parsed as PersistedState;
}

function createEmptyPersistedState(topicId: string): PersistedState {
  return {
    version: 'v1',
    topicId,
    runs: [],
  };
}

function updateRun(
  store: StateStore,
  runId: string,
  update: (run: RunRecord) => RunRecord,
): StateStore {
  let found = false;
  const runs = store.state.runs.map((run) => {
    if (run.id !== runId) {
      return run;
    }
    found = true;
    return update(run);
  });
  if (!found) {
    throw new Error(`Run not found in state: ${runId}`);
  }
  return updateStore(store, {
    ...store.state,
    runs,
  });
}

function updateStore(store: StateStore, state: PersistedState): StateStore {
  savePersistedState(store.statePath, state);
  return {
    ...store,
    state,
  };
}

function savePersistedState(statePath: string, state: PersistedState): void {
  validateState(state, statePath);
  mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, statePath);
}

function validateState(value: unknown, statePath: string): void {
  if (!validatePersistedState(value)) {
    throw new Error(`Invalid state ${statePath}: ${ajv.errorsText(validatePersistedState.errors)}`);
  }
}

function validateKeepRuns(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid keepRuns: expected an integer >= 0, received ${value}`);
  }
}

function countStateRecords(state: PersistedState): StateCounts {
  const memories = flattenMemories(state);
  const modelOutputs = flattenModelOutputs(state);
  const evidenceMessages = flattenEvidenceMessages(state);
  return {
    runs: state.runs.length,
    memories: memories.length,
    modelOutputs: modelOutputs.length,
    evidenceMessages: evidenceMessages.length,
  };
}
