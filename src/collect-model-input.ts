import type { DateRange } from './date-range.js';
import { buildModelInputSegments } from './llm/segmentation.js';
import { logger } from './logger.js';
import { prepareAnalysisRuntime } from './runtime/analysis.js';
import { buildRunState } from './state/build-state.js';
import type { ResolvedConfig, RunState } from './types.js';

export type CollectedModelInput = {
  readonly topicId: string;
  readonly inputMessageCount: number;
  readonly matchedMessageCount: number;
  readonly evidenceMessageCount: number;
  readonly executionMode: 'explicit' | 'implicit';
  readonly scanStartCursor: string | null;
  readonly scanEndCursor: string | null;
  readonly modelCalled: boolean;
  readonly reason?: 'no_matches' | 'no_evidence_in_date_range' | undefined;
  readonly modelInput?:
    | {
        readonly system: string;
        readonly prompt: string;
      }
    | undefined;
  readonly state?: RunState | undefined;
  readonly modelInputs?:
    | readonly {
        readonly segmentId: string;
        readonly estimatedInputTokens: number;
        readonly tokenEstimateMethod: string;
        readonly system: string;
        readonly prompt: string;
      }[]
    | undefined;
};

export async function collectModelInput(
  resolved: ResolvedConfig,
  options: {
    readonly dateRange?: DateRange | undefined;
    readonly stateOnly?: boolean | undefined;
  } = {},
): Promise<CollectedModelInput> {
  const { config, topicId } = resolved;
  const prepared = await prepareAnalysisRuntime(resolved, options);
  if (prepared.reason) {
    return {
      topicId,
      inputMessageCount: prepared.inputMessageCount,
      matchedMessageCount: prepared.matchedMessageCount,
      evidenceMessageCount: prepared.evidenceMessageCount,
      executionMode: prepared.executionMode,
      scanStartCursor: prepared.scanStartCursor,
      scanEndCursor: prepared.scanEndCursor,
      modelCalled: false,
      reason: prepared.reason,
    };
  }

  const buildState = (segmentEvidence: typeof prepared.evidence, previousMemory: string | null) =>
    buildRunState({
      runId: 'dry-run',
      config,
      topicId,
      generatedAt: new Date().toISOString(),
      previousCursor: prepared.scanStartCursor,
      currentMaxCursor: prepared.scanEndCursor,
      matches: prepared.matches,
      evidence: segmentEvidence,
      previousMemory,
      localTimeZone: prepared.localTimeZone,
      workspaceId: prepared.workspaceId,
      knownUsers: prepared.knownUsers,
    });

  if (options.stateOnly) {
    return {
      topicId,
      inputMessageCount: prepared.inputMessageCount,
      matchedMessageCount: prepared.matchedMessageCount,
      evidenceMessageCount: prepared.evidenceMessageCount,
      executionMode: prepared.executionMode,
      scanStartCursor: prepared.scanStartCursor,
      scanEndCursor: prepared.scanEndCursor,
      modelCalled: true,
      state: buildState(prepared.evidence, prepared.previousMemory),
    };
  }

  const segments = await buildModelInputSegments({
    config,
    evidence: prepared.evidence,
    matches: prepared.matches,
    previousMemory: prepared.previousMemory,
    localTimeZone: prepared.localTimeZone,
    buildState,
  });
  logger.debug(
    {
      topicId,
      workspaceId: prepared.workspaceId,
      segments: segments.map((segment) => ({
        segmentId: segment.id,
        estimatedInputTokens: segment.estimatedInputTokens,
        tokenEstimateMethod: segment.tokenEstimateMethod,
        system: segment.compiled.system,
        prompt: segment.compiled.prompt,
      })),
    },
    'analysis model input collected',
  );

  return {
    topicId,
    inputMessageCount: prepared.inputMessageCount,
    matchedMessageCount: prepared.matchedMessageCount,
    evidenceMessageCount: prepared.evidenceMessageCount,
    executionMode: prepared.executionMode,
    scanStartCursor: prepared.scanStartCursor,
    scanEndCursor: prepared.scanEndCursor,
    modelCalled: true,
    ...(segments.length === 1
      ? {
          modelInput: {
            system: segments[0]?.compiled.system ?? '',
            prompt: segments[0]?.compiled.prompt ?? '',
          },
        }
      : {}),
    modelInputs: segments.map((segment) => ({
      segmentId: segment.id,
      estimatedInputTokens: segment.estimatedInputTokens,
      tokenEstimateMethod: segment.tokenEstimateMethod,
      system: segment.compiled.system,
      prompt: segment.compiled.prompt,
    })),
  };
}
