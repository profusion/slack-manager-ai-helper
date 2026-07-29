import { localDateForSlackTs } from '../date-range.js';
import type { EvidenceMessage, MatchResult, ResolvedAppConfig, RunState } from '../types.js';
import { effectiveContextWindowTokens, effectiveReservedOutputTokens } from './model-config.js';
import { compilePrompts } from './prompt.js';
import { estimateModelTokens, type TokenEstimate, tokenSafetyMargin } from './token-estimate.js';

export type ModelInputSegment = {
  readonly id: string;
  readonly evidence: readonly EvidenceMessage[];
  readonly compiled: {
    readonly system: string;
    readonly prompt: string;
    readonly outputSchema: unknown | undefined;
    readonly structuredOutputSchema: unknown | undefined;
  };
  readonly estimatedInputTokens: number;
  readonly tokenEstimateMethod: TokenEstimate['method'];
};

export async function rebuildModelInputSegment(input: {
  readonly segment: ModelInputSegment;
  readonly config: ResolvedAppConfig;
  readonly buildState: (
    evidence: readonly EvidenceMessage[],
    previousMemory: string | null,
  ) => RunState;
  readonly previousMemory: string | null;
}): Promise<ModelInputSegment> {
  const rebuilt = await compileCandidate({
    config: input.config,
    buildState: input.buildState,
    evidence: input.segment.evidence,
    previousMemory: input.previousMemory,
    id: input.segment.id,
  });
  assertFitsContextWindow(rebuilt, input.config);
  return rebuilt;
}

export async function buildModelInputSegments(input: {
  readonly config: ResolvedAppConfig;
  readonly buildState: (
    evidence: readonly EvidenceMessage[],
    previousMemory: string | null,
  ) => RunState;
  readonly evidence: readonly EvidenceMessage[];
  readonly matches: readonly MatchResult[];
  readonly previousMemory: string | null;
  readonly localTimeZone: string;
}): Promise<readonly ModelInputSegment[]> {
  if (!effectiveContextWindowTokens(input.config.model)) {
    const state = input.buildState(input.evidence, input.previousMemory);
    const compiled = await compilePrompts(input.config, state);
    const estimate = estimateCompiledInput(compiled.system, compiled.prompt, input.config);
    return [
      {
        id: 'all',
        evidence: input.evidence,
        compiled,
        estimatedInputTokens: estimate.tokens,
        tokenEstimateMethod: estimate.method,
      },
    ];
  }

  return buildSegmentedModelInputs(input);
}

async function buildSegmentedModelInputs(input: {
  readonly config: ResolvedAppConfig;
  readonly buildState: (
    evidence: readonly EvidenceMessage[],
    previousMemory: string | null,
  ) => RunState;
  readonly evidence: readonly EvidenceMessage[];
  readonly matches: readonly MatchResult[];
  readonly previousMemory: string | null;
  readonly localTimeZone: string;
}): Promise<readonly ModelInputSegment[]> {
  const units = groupEvidenceUnits(input.evidence, input.localTimeZone);
  const segments: ModelInputSegment[] = [];
  let pending: EvidenceMessage[] = [];
  let pendingIdParts: string[] = [];

  for (const unit of units) {
    const candidateEvidence = [...pending, ...unit.evidence];
    const candidate = await compileCandidate({
      ...input,
      evidence: candidateEvidence,
      previousMemory: input.previousMemory,
      id: [...pendingIdParts, unit.id].join('__'),
    });

    if (fitsContextWindow(candidate, input.config)) {
      pending = candidateEvidence;
      pendingIdParts = [...pendingIdParts, unit.id];
      continue;
    }

    if (pending.length > 0) {
      const segment = await compileCandidate({
        ...input,
        evidence: pending,
        previousMemory: input.previousMemory,
        id: pendingIdParts.join('__'),
      });
      assertFitsContextWindow(segment, input.config);
      segments.push(segment);
      pending = unit.evidence.slice();
      pendingIdParts = [unit.id];
      continue;
    }

    assertFitsContextWindow(candidate, input.config);
    segments.push(candidate);
    pending = [];
    pendingIdParts = [];
  }

  if (pending.length > 0) {
    const segment = await compileCandidate({
      ...input,
      evidence: pending,
      previousMemory: input.previousMemory,
      id: pendingIdParts.join('__'),
    });
    assertFitsContextWindow(segment, input.config);
    segments.push(segment);
  }

  return segments;
}

async function compileCandidate(input: {
  readonly config: ResolvedAppConfig;
  readonly buildState: (
    evidence: readonly EvidenceMessage[],
    previousMemory: string | null,
  ) => RunState;
  readonly evidence: readonly EvidenceMessage[];
  readonly previousMemory: string | null;
  readonly id: string;
}): Promise<ModelInputSegment> {
  const state = input.buildState(input.evidence, input.previousMemory);
  const compiled = await compilePrompts(input.config, state);
  const estimate = estimateCompiledInput(compiled.system, compiled.prompt, input.config);

  return {
    id: input.id,
    evidence: input.evidence,
    compiled,
    estimatedInputTokens: estimate.tokens,
    tokenEstimateMethod: estimate.method,
  };
}

function estimateCompiledInput(
  system: string,
  prompt: string,
  config: ResolvedAppConfig,
): TokenEstimate {
  return estimateModelTokens(`${system}\n\n${prompt}`, config.model);
}

function fitsContextWindow(segment: ModelInputSegment, config: ResolvedAppConfig): boolean {
  const contextWindowTokens = effectiveContextWindowTokens(config.model);
  if (!contextWindowTokens) {
    return true;
  }

  const reservedOutputTokens = effectiveReservedOutputTokens(config.model);
  const adjustedInputTokens = Math.ceil(
    segment.estimatedInputTokens * tokenSafetyMargin(segment.tokenEstimateMethod),
  );
  return adjustedInputTokens + reservedOutputTokens <= contextWindowTokens;
}

function assertFitsContextWindow(segment: ModelInputSegment, config: ResolvedAppConfig): void {
  if (fitsContextWindow(segment, config)) {
    return;
  }

  const contextWindowTokens = effectiveContextWindowTokens(config.model);
  const reservedOutputTokens = effectiveReservedOutputTokens(config.model);
  const adjustedInputTokens = Math.ceil(
    segment.estimatedInputTokens * tokenSafetyMargin(segment.tokenEstimateMethod),
  );
  throw new Error(
    [
      `Model input segment "${segment.id}" exceeds configured contextWindowTokens.`,
      `estimatedInputTokens=${segment.estimatedInputTokens}`,
      `adjustedInputTokens=${adjustedInputTokens}`,
      `reservedOutputTokens=${reservedOutputTokens}`,
      `contextWindowTokens=${contextWindowTokens}`,
      `tokenEstimateMethod=${segment.tokenEstimateMethod}`,
    ].join(' '),
  );
}

function groupEvidenceUnits(
  evidence: readonly EvidenceMessage[],
  localTimeZone: string,
): readonly { readonly id: string; readonly evidence: readonly EvidenceMessage[] }[] {
  const grouped = new Map<string, EvidenceMessage[]>();

  for (const message of evidence) {
    const date = localDateForSlackTs(message.ts, localTimeZone);
    const key = `${date}__${message.channelId}`;
    const messages = grouped.get(key) ?? [];
    messages.push(message);
    grouped.set(key, messages);
  }

  return [...grouped.entries()]
    .map(([id, messages]) => ({
      id,
      evidence: messages.toSorted((left, right) => left.ts.localeCompare(right.ts)),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
