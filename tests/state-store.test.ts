import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compactState,
  createRun,
  finishRun,
  latestSuccessfulImplicitRun,
  openStateStore,
  type PersistedState,
  readPreviousMemory,
  saveMemory,
} from '../src/state/state-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('state store run windows', () => {
  it('uses the latest completed implicit run as the next implicit start', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-state-'));
    tempDirs.push(dir);
    let store = openStateStore(path.join(dir, 'state-topic.json'), 'topic');

    store = createCompletedRun(store, 'old', {
      executionMode: 'implicit',
      scanStartCursor: null,
      scanEndCursor: '1000',
      startedAt: '2026-06-01T00:00:00.000Z',
      finishedAt: '2026-06-01T00:01:00.000Z',
    });
    store = createCompletedRun(store, 'explicit', {
      executionMode: 'explicit',
      scanStartCursor: '1000',
      scanEndCursor: '2000',
      startedAt: '2026-06-02T00:00:00.000Z',
      finishedAt: '2026-06-02T00:01:00.000Z',
    });
    store = createCompletedRun(store, 'latest', {
      executionMode: 'implicit',
      scanStartCursor: '1000',
      scanEndCursor: '3000',
      startedAt: '2026-06-03T00:00:00.000Z',
      finishedAt: '2026-06-03T00:01:00.000Z',
    });

    expect(latestSuccessfulImplicitRun(store)?.id).toBe('latest');
  });

  it('selects previous memory from the latest earlier memory-bearing run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-state-'));
    tempDirs.push(dir);
    let store = openStateStore(path.join(dir, 'state-topic.json'), 'topic');

    store = createCompletedRun(store, 'memory-run', {
      executionMode: 'implicit',
      scanStartCursor: null,
      scanEndCursor: '1000',
      startedAt: '2026-06-01T00:00:00.000Z',
      finishedAt: '2026-06-01T00:01:00.000Z',
    });
    store = saveMemory(store, {
      id: 'memory-1',
      topicId: 'topic',
      content: 'previous memory',
      createdAt: '2026-06-01T00:01:00.000Z',
      runId: 'memory-run',
    });
    store = createCompletedRun(store, 'no-memory-run', {
      executionMode: 'implicit',
      scanStartCursor: '1000',
      scanEndCursor: '2000',
      startedAt: '2026-06-02T00:00:00.000Z',
      finishedAt: '2026-06-02T00:01:00.000Z',
    });

    expect(
      readPreviousMemory(store, {
        executionMode: 'implicit',
        scanStartCursor: '2000',
        scanEndCursor: '3000',
      }),
    ).toBe('previous memory');
  });

  it('does not feed same-range reruns from earlier same-range memory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-state-'));
    tempDirs.push(dir);
    let store = openStateStore(path.join(dir, 'state-topic.json'), 'topic');

    store = createCompletedRun(store, 'same-range', {
      executionMode: 'explicit',
      scanStartCursor: '1000',
      scanEndCursor: '2000',
      startedAt: '2026-06-01T00:00:00.000Z',
      finishedAt: '2026-06-01T00:01:00.000Z',
    });
    store = saveMemory(store, {
      id: 'memory-1',
      topicId: 'topic',
      content: 'same range memory',
      createdAt: '2026-06-01T00:01:00.000Z',
      runId: 'same-range',
    });

    expect(
      readPreviousMemory(store, {
        executionMode: 'explicit',
        scanStartCursor: '1000',
        scanEndCursor: '2000',
      }),
    ).toBeNull();
  });
});

describe('state store compaction', () => {
  it('keeps newest full runs and memory-bearing history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-state-'));
    tempDirs.push(dir);
    const statePath = path.join(dir, 'state-topic.json');
    await writeFile(statePath, `${JSON.stringify(createCompactionState(), null, 2)}\n`);
    const store = openStateStore(statePath, 'topic');

    const result = compactState(store, { keepRuns: 2 });
    const compacted = JSON.parse(await readFile(statePath, 'utf8')) as PersistedState;

    expect(result.summary).toMatchObject({
      before: {
        runs: 4,
        memories: 5,
        modelOutputs: 4,
        evidenceMessages: 4,
      },
      after: {
        runs: 3,
        memories: 4,
        modelOutputs: 2,
        evidenceMessages: 2,
      },
      removed: {
        runs: 1,
        memories: 1,
        modelOutputs: 2,
        evidenceMessages: 2,
      },
      retainedRunIds: ['run-3', 'run-4'],
    });
    expect(compacted.runs.map((run) => run.id)).toEqual(['run-1', 'run-3', 'run-4']);
    expect(compacted.runs.find((run) => run.id === 'run-1')?.modelOutputs).toEqual([]);
    expect(compacted.runs.find((run) => run.id === 'run-1')?.evidenceMessages).toEqual([]);
    expect(compacted.runs.flatMap((run) => run.memories.map((memory) => memory.id))).toEqual([
      'memory-old-global',
      'memory-old-action',
      'memory-new-channel',
      'memory-new-global',
    ]);
  });

  it('keeps latest memories by scope when keeping zero full runs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-state-'));
    tempDirs.push(dir);
    const statePath = path.join(dir, 'state-topic.json');
    await writeFile(statePath, `${JSON.stringify(createCompactionState(), null, 2)}\n`);
    const store = openStateStore(statePath, 'topic');

    const result = compactState(store, { keepRuns: 0 });
    const compacted = JSON.parse(await readFile(statePath, 'utf8')) as PersistedState;

    expect(result.summary.retainedRunIds).toEqual([]);
    expect(compacted.runs.map((run) => run.id)).toEqual(['run-1', 'run-3', 'run-4']);
    expect(compacted.runs.flatMap((run) => run.modelOutputs)).toEqual([]);
    expect(compacted.runs.flatMap((run) => run.evidenceMessages)).toEqual([]);
    expect(compacted.runs.flatMap((run) => run.memories.map((memory) => memory.id))).toEqual([
      'memory-old-global',
      'memory-old-action',
      'memory-new-channel',
      'memory-new-global',
    ]);
  });

  it('keeps all runs when keepRuns exceeds the current run count', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smah-state-'));
    tempDirs.push(dir);
    const statePath = path.join(dir, 'state-topic.json');
    await writeFile(statePath, `${JSON.stringify(createCompactionState(), null, 2)}\n`);
    const store = openStateStore(statePath, 'topic');

    const result = compactState(store, { keepRuns: 99 });

    expect(result.summary.after.runs).toBe(4);
    expect(result.summary.removed.runs).toBe(0);
    expect(result.summary.retainedRunIds).toEqual(['run-1', 'run-2', 'run-3', 'run-4']);
  });
});

function createCompletedRun(
  store: ReturnType<typeof openStateStore>,
  id: string,
  input: {
    readonly executionMode: 'explicit' | 'implicit';
    readonly scanStartCursor: string | null;
    readonly scanEndCursor: string | null;
    readonly startedAt: string;
    readonly finishedAt: string;
  },
) {
  return finishRun(
    createRun(store, {
      id,
      topicId: 'topic',
      configHash: `hash-${id}`,
      startedAt: input.startedAt,
      window: {
        executionMode: input.executionMode,
        scanStartCursor: input.scanStartCursor,
        scanEndCursor: input.scanEndCursor,
      },
    }),
    {
      id,
      finishedAt: input.finishedAt,
      status: 'completed',
      inputMessageCount: 1,
      matchedMessageCount: 1,
      evidenceMessageCount: 1,
      modelCalled: true,
    },
  );
}

function createCompactionState(): PersistedState {
  return {
    version: 'v1',
    topicId: 'topic',
    runs: ['run-1', 'run-2', 'run-3', 'run-4'].map((id, index) => ({
      id,
      topicId: 'topic',
      configHash: `hash-${index}`,
      startedAt: `2026-06-0${index + 1}T00:00:00.000Z`,
      finishedAt: `2026-06-0${index + 1}T00:01:00.000Z`,
      status: 'completed',
      executionMode: 'implicit',
      scanStartCursor: index === 0 ? null : String(index * 1000),
      scanEndCursor: String((index + 1) * 1000),
      scanStartedAt: `2026-06-0${index + 1}T00:00:00.000Z`,
      scanEndedAt: `2026-06-0${index + 1}T00:01:00.000Z`,
      inputMessageCount: 1,
      matchedMessageCount: 1,
      evidenceMessageCount: 1,
      modelCalled: true,
      memories: memoriesForRun(id),
      modelOutputs: [
        {
          id: `output-${index + 1}`,
          runId: id,
          topicId: 'topic',
          outputText: `output ${index + 1}`,
          schemaValid: null,
          createdAt: `2026-06-0${index + 1}T00:02:00.000Z`,
        },
      ],
      evidenceMessages: [
        {
          id: `${id}:0`,
          runId: id,
          topicId: 'topic',
          channelId: 'C1',
          ts: String(index + 1),
          text: `evidence ${index + 1}`,
          source: 'match',
        },
      ],
    })),
  };
}

function memoriesForRun(runId: string) {
  switch (runId) {
    case 'run-1':
      return [
        memory('memory-old-global', runId, 'global', null, '2026-06-01T00:00:00.000Z'),
        memory('memory-old-action', runId, 'action', 'A1', '2026-06-01T00:00:00.000Z'),
      ];
    case 'run-2':
      return [memory('memory-old-channel', runId, 'channel', 'C1', '2026-06-02T00:00:00.000Z')];
    case 'run-3':
      return [memory('memory-new-channel', runId, 'channel', 'C1', '2026-06-03T00:00:00.000Z')];
    case 'run-4':
      return [memory('memory-new-global', runId, 'global', null, '2026-06-04T00:00:00.000Z')];
    default:
      return [];
  }
}

function memory(
  id: string,
  runId: string,
  scope: string,
  scopeId: string | null,
  createdAt: string,
) {
  return {
    id,
    topicId: 'topic',
    scope,
    scopeId,
    content: id,
    contentType: 'text',
    createdAt,
    runId,
  };
}
