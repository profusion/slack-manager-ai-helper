import { randomUUID } from 'node:crypto';
import type { DateRange } from './date-range.js';
import { type GenerateModelText, generateModelText, type ModelUsage } from './llm/generate.js';
import { analysisModelChain, retryCountForModel } from './llm/model-config.js';
import { validateModelOutput } from './llm/output-validation.js';
import {
  buildModelInputSegments,
  type ModelInputSegment,
  rebuildModelInputSegment,
} from './llm/segmentation.js';
import { openAiCompatibleJsonSchema } from './llm/strict-json-schema.js';
import { logger } from './logger.js';
import { findMatches } from './matching/matchers.js';
import { createRedactor } from './redaction.js';
import {
  filterEvidenceByDateRange,
  filterMatchesByDateRange,
  resolveRunWindow,
} from './runtime/analysis.js';
import { canonicalizeSlackEvidenceLinks } from './slack/evidence-reference.js';
import { readSlacrawlDirectoryFromSource } from './slacrawl/directory.js';
import { openSlacrawlDatabase, readMessagesSince } from './slacrawl/slacrawl-db.js';
import { buildRunState } from './state/build-state.js';
import { expandEvidence } from './state/context.js';
import {
  createRun,
  finishRun,
  openStateStore,
  type RunWindow,
  readPreviousMemory,
  saveEvidenceMessages,
  saveMemory,
  saveModelOutput,
} from './state/state-store.js';
import type {
  AnalysisModelConfig,
  EvidenceMessage,
  ModelCallRecord,
  ResolvedConfig,
} from './types.js';
import { resolveLocalTimeZone } from './utils/local-time.js';

export type RunOnceResult = {
  readonly runId: string;
  readonly inputMessageCount: number;
  readonly matchedMessageCount: number;
  readonly evidenceMessageCount: number;
  readonly modelCalled: boolean;
  readonly executionMode: RunWindow['executionMode'];
  readonly scanStartCursor: string | null;
  readonly scanEndCursor: string | null;
  readonly reportText?: string | undefined;
};

export type RunOnceOptions = {
  readonly dateRange?: DateRange | undefined;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the linear run orchestration; extracting branches would obscure failure handling.
export async function runOnce(
  resolved: ResolvedConfig,
  generateTextOverride: GenerateModelText = generateModelText,
  options: RunOnceOptions = {},
): Promise<RunOnceResult> {
  const { config } = resolved;
  const { topicId } = resolved;
  const startedAt = new Date().toISOString();
  const localTimeZone = resolveLocalTimeZone();
  const runId = randomUUID();
  let store = openStateStore(config.storage.statePath, topicId);
  let inputMessageCount = 0;
  let matchedMessageCount = 0;
  let evidenceMessageCount = 0;
  let modelCalled = false;
  let runWindow: RunWindow | null = null;
  let runCreated = false;
  let reportTextForStdout: string | undefined;
  const redactor = createRedactor(config.redaction);

  try {
    logger.info(
      {
        topicId,
        slacrawlDatabasePath: config.storage.slacrawlDatabasePath,
        statePath: config.storage.statePath,
      },
      'config loaded',
    );

    const source = openSlacrawlDatabase(config.storage.slacrawlDatabasePath, {
      redactMessage: redactor.redactMessage,
    });
    try {
      const workspaceId = source.workspaceId;
      const knownUsers = readSlacrawlDirectoryFromSource(source, config.channels).users;
      logger.info({ topicId, workspaceId, schema: source.schema }, 'detected slacrawl schema');

      const channelIds = config.channels.map((channel) => channel.id);
      runWindow = resolveRunWindow({
        source,
        channelIds,
        store,
        localTimeZone,
        dateRange: options.dateRange,
      });
      store = createRun(store, {
        id: runId,
        topicId,
        configHash: resolved.configHash,
        startedAt,
        window: runWindow,
      });
      runCreated = true;
      logger.info({ topicId, workspaceId, runWindow }, 'run window resolved');

      const messages = readMessagesSince(source, {
        channelIds,
        afterCursor: runWindow.scanStartCursor,
        beforeOrAtCursor: runWindow.scanEndCursor,
      });
      inputMessageCount = messages.length;
      logger.info({ topicId, workspaceId, inputMessageCount, channelIds }, 'new messages scanned');

      const logContext = {
        workspaceId,
      };
      const allMatches = await findMatches(messages, config, logContext);
      const matches = filterMatchesByDateRange(allMatches, options.dateRange, localTimeZone);
      matchedMessageCount = matches.length;
      logger.info({ topicId, workspaceId, matchedMessageCount }, 'messages matched');

      if (matches.length > 0) {
        const rawEvidence = await expandEvidence(source, matches, config, logContext);
        const evidence = filterEvidenceByDateRange(rawEvidence, options.dateRange, localTimeZone);
        evidenceMessageCount = evidence.length;
        logger.info(
          {
            topicId,
            workspaceId,
            evidenceMessageCount,
            rawEvidenceMessageCount: rawEvidence.length,
            dateRange: options.dateRange,
          },
          'evidence messages selected',
        );

        if (evidence.length === 0) {
          logger.info(
            { topicId, workspaceId, modelCalled: false, dateRange: options.dateRange },
            'no evidence in requested date range; model not called',
          );
        } else {
          const previousMemory = readPreviousMemory(store, runWindow);
          const redactedPreviousMemory =
            previousMemory === null ? null : redactor.redactText(previousMemory);
          const buildSegmentState = (
            segmentEvidence: readonly EvidenceMessage[],
            segmentPreviousMemory: string | null,
          ) =>
            buildRunState({
              runId,
              config,
              topicId,
              generatedAt: new Date().toISOString(),
              previousCursor: runWindow?.scanStartCursor ?? null,
              currentMaxCursor: runWindow?.scanEndCursor ?? null,
              matches,
              evidence: segmentEvidence,
              previousMemory: segmentPreviousMemory,
              localTimeZone,
              workspaceId,
              knownUsers,
            });
          const segments = await buildModelInputSegments({
            config,
            evidence,
            matches,
            previousMemory: redactedPreviousMemory,
            localTimeZone,
            buildState: buildSegmentState,
          });
          modelCalled = true;
          const segmentOutputs = [];
          let sameRunMemory = redactedPreviousMemory;
          for (const segment of segments) {
            const rebuiltSegment = await rebuildModelInputSegment({
              segment,
              config,
              buildState: buildSegmentState,
              previousMemory: sameRunMemory,
            });
            segmentOutputs.push(
              await callAnalysisModelSegment({
                segment: rebuiltSegment,
                config,
                topicId,
                workspaceId,
                redactor: redactor.redactText,
                generateText: generateTextOverride,
              }),
            );
            const latestSegmentOutput = segmentOutputs.at(-1);
            sameRunMemory = mergeSameRunMemory(sameRunMemory, latestSegmentOutput?.memoryText);
          }
          const combinedOutput = combineSegmentOutputs(segmentOutputs);

          store = saveEvidenceMessages(store, {
            runId,
            topicId,
            messages: evidence,
          });
          store = saveModelOutput(store, {
            id: randomUUID(),
            runId,
            topicId,
            outputText: combinedOutput.outputText,
            reportText: combinedOutput.reportText ?? undefined,
            outputJson: redactor.redactJson(combinedOutput.outputJson),
            schemaValid: combinedOutput.schemaValid ?? undefined,
            schemaErrors: combinedOutput.schemaErrors,
            modelProvider: combinedOutput.modelProvider,
            modelName: combinedOutput.modelName,
            modelAttempts: combinedOutput.modelAttempts,
            modelCalls: combinedOutput.modelCalls,
            usage: combinedOutput.usage,
            createdAt: new Date().toISOString(),
          });
          reportTextForStdout = combinedOutput.reportText ?? undefined;

          const memory = combinedOutput.memoryText;
          if (memory) {
            store = saveMemory(store, {
              id: randomUUID(),
              topicId,
              content: memory,
              createdAt: new Date().toISOString(),
              runId,
            });
          }
        }
      } else {
        logger.info({ topicId, workspaceId, modelCalled: false }, 'no matches; model not called');
      }
    } finally {
      source.close();
    }

    store = finishRun(store, {
      id: runId,
      finishedAt: new Date().toISOString(),
      status: 'completed',
      inputMessageCount,
      matchedMessageCount,
      evidenceMessageCount,
      modelCalled,
    });

    return {
      runId,
      inputMessageCount,
      matchedMessageCount,
      evidenceMessageCount,
      modelCalled,
      executionMode: runWindow?.executionMode ?? 'implicit',
      scanStartCursor: runWindow?.scanStartCursor ?? null,
      scanEndCursor: runWindow?.scanEndCursor ?? null,
      reportText: reportTextForStdout,
    };
  } catch (error) {
    if (runCreated) {
      store = finishRun(store, {
        id: runId,
        finishedAt: new Date().toISOString(),
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        inputMessageCount,
        matchedMessageCount,
        evidenceMessageCount,
        modelCalled,
      });
    }
    throw error;
  }
}

type SegmentModelOutput = {
  readonly segmentId: string;
  readonly outputText: string;
  readonly reportText?: string | undefined;
  readonly memoryText?: string | undefined;
  readonly outputJson?: unknown;
  readonly schemaValid?: boolean | null | undefined;
  readonly schemaErrors?: unknown;
  readonly modelProvider?: string | undefined;
  readonly modelName?: string | undefined;
  readonly modelAttempts?: number | undefined;
  readonly modelCalls?: readonly ModelCallRecord[] | undefined;
  readonly usage?: ModelUsage | undefined;
};

type AnalysisModelAttemptOutput = SegmentModelOutput & {
  readonly attemptUsage?: ModelUsage | undefined;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Retry and fallback ordering is clearer as one state machine.
async function callAnalysisModelSegment(input: {
  readonly segment: ModelInputSegment;
  readonly config: ResolvedConfig['config'];
  readonly topicId: string;
  readonly workspaceId: string | null;
  readonly redactor: (text: string) => string;
  readonly generateText: GenerateModelText;
}): Promise<SegmentModelOutput> {
  const { segment, config, topicId, workspaceId } = input;
  const { compiled } = segment;
  logger.debug(
    {
      topicId,
      workspaceId,
      segmentId: segment.id,
      system: compiled.system,
      prompt: compiled.prompt,
    },
    'analysis model input prepared',
  );
  logger.info(
    {
      topicId,
      workspaceId,
      segmentId: segment.id,
      evidenceMessageCount: segment.evidence.length,
      modelChain: analysisModelChain(config.model).map((modelConfig) => ({
        provider: modelConfig.provider,
        model: modelConfig.model,
        retries: retryCountForModel(modelConfig),
        temperature: modelConfig.temperature,
        maxOutputTokens: modelConfig.maxOutputTokens,
        contextWindowTokens: modelConfig.contextWindowTokens,
      })),
      estimatedInputTokens: segment.estimatedInputTokens,
      tokenEstimateMethod: segment.tokenEstimateMethod,
      systemLength: compiled.system.length,
      promptLength: compiled.prompt.length,
    },
    'analysis model call started',
  );

  let prompt = compiled.prompt;
  let cumulativeUsage: ModelUsage | undefined;
  let lastOutput: SegmentModelOutput | undefined;
  let lastError: unknown;
  let lastFailureKind: 'error' | 'schema' | undefined;
  let totalAttempts = 0;
  const modelCalls: ModelCallRecord[] = [];
  const modelChain = analysisModelChain(config.model);

  for (const [modelIndex, modelConfig] of modelChain.entries()) {
    const maxAttempts = retryCountForModel(modelConfig) + 1;
    let modelAttempts = 0;
    prompt = compiled.prompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let attemptOutput: AnalysisModelAttemptOutput;
      totalAttempts += 1;
      modelAttempts += 1;
      try {
        attemptOutput = await callAnalysisModelAttempt({
          segment,
          config,
          modelConfig,
          topicId,
          workspaceId,
          prompt,
          attempt,
          redactor: input.redactor,
          generateText: input.generateText,
        });
      } catch (error) {
        lastError = error;
        lastFailureKind = 'error';
        if (attempt === maxAttempts) {
          break;
        }

        logger.warn(
          {
            topicId,
            workspaceId,
            segmentId: segment.id,
            provider: modelConfig.provider,
            model: modelConfig.model,
            attempt,
            nextAttempt: attempt + 1,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          'analysis model call failed; retrying',
        );
        continue;
      }

      lastError = undefined;
      lastFailureKind = undefined;
      cumulativeUsage = combineModelUsage([cumulativeUsage, attemptOutput.attemptUsage]);
      logger.info(
        {
          topicId,
          workspaceId,
          segmentId: segment.id,
          provider: modelConfig.provider,
          model: modelConfig.model,
          attempt,
          schemaValid: attemptOutput.schemaValid,
        },
        'output validation completed',
      );

      lastOutput = {
        ...attemptOutput,
        modelProvider: modelConfig.provider,
        modelName: modelConfig.model,
        modelAttempts: totalAttempts,
        modelCalls: [
          ...modelCalls,
          {
            segmentId: segment.id,
            provider: modelConfig.provider,
            model: modelConfig.model,
            attempts: modelAttempts,
          },
        ],
        usage: cumulativeUsage,
      };

      if (attemptOutput.schemaValid !== false) {
        return lastOutput;
      }

      if (!modelConfig.failOnInvalidOutput) {
        return lastOutput;
      }

      if (attempt === maxAttempts) {
        lastFailureKind = 'schema';
        break;
      }

      logger.warn(
        {
          topicId,
          workspaceId,
          segmentId: segment.id,
          provider: modelConfig.provider,
          model: modelConfig.model,
          attempt,
          nextAttempt: attempt + 1,
          schemaErrors: attemptOutput.schemaErrors,
        },
        'analysis model output failed schema validation; retrying',
      );
      prompt = buildInvalidOutputRetryPrompt(compiled.prompt, attemptOutput.schemaErrors);
    }

    const nextModel = modelChain[modelIndex + 1];
    modelCalls.push({
      segmentId: segment.id,
      provider: modelConfig.provider,
      model: modelConfig.model,
      attempts: modelAttempts,
    });
    if (nextModel) {
      logger.warn(
        {
          topicId,
          workspaceId,
          segmentId: segment.id,
          provider: modelConfig.provider,
          model: modelConfig.model,
          fallbackProvider: nextModel.provider,
          fallbackModel: nextModel.model,
          errorMessage: lastError instanceof Error ? lastError.message : undefined,
          schemaErrors: lastOutput?.schemaErrors,
        },
        'analysis model exhausted retries; falling back',
      );
    }
  }

  if (lastFailureKind === 'schema' && lastOutput?.schemaValid === false) {
    throw new Error(
      `Model output failed schema validation after exhausting ${modelChain.length} model(s): ${JSON.stringify(
        lastOutput.schemaErrors,
      )}`,
    );
  }

  throw new Error(
    `Analysis model failed after exhausting ${modelChain.length} model(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function callAnalysisModelAttempt(input: {
  readonly segment: ModelInputSegment;
  readonly config: ResolvedConfig['config'];
  readonly modelConfig: AnalysisModelConfig;
  readonly topicId: string;
  readonly workspaceId: string | null;
  readonly prompt: string;
  readonly attempt: number;
  readonly redactor: (text: string) => string;
  readonly generateText: GenerateModelText;
}): Promise<AnalysisModelAttemptOutput> {
  const { segment, config, modelConfig, topicId, workspaceId, prompt, attempt } = input;
  const { compiled } = segment;
  const outputSchema = usesOpenAiStructuredOutputSchema(modelConfig)
    ? openAiCompatibleJsonSchema(compiled.structuredOutputSchema)
    : compiled.structuredOutputSchema;
  const modelResult = await input.generateText({
    config: { ...config, model: modelConfig },
    system: compiled.system,
    prompt,
    outputSchema,
  });
  const attemptUsage = modelResult.usage;
  logger.info(
    {
      topicId,
      workspaceId,
      segmentId: segment.id,
      provider: modelConfig.provider,
      model: modelConfig.model,
      attempt,
      usage: attemptUsage,
    },
    'analysis model call completed',
  );
  if (compiled.structuredOutputSchema === undefined) {
    throw new Error('Analysis prompts must define a jsonschema block for structured output');
  }

  const structuredOutput = redactAndCanonicalizeStructuredOutput(
    modelResult.output ?? modelResult.text,
    segment.evidence,
    config.workspaceUrl,
    input.redactor,
  );
  const redactedOutputText =
    structuredOutput === undefined
      ? canonicalizeSlackEvidenceLinks(
          input.redactor(modelResult.text),
          segment.evidence,
          config.workspaceUrl,
        )
      : JSON.stringify(structuredOutput);
  logger.debug(
    { topicId, workspaceId, segmentId: segment.id, attempt, outputText: redactedOutputText },
    'analysis model output received',
  );
  const reportText = structuredOutput?.reportText.trim() || undefined;

  const validation = validateModelOutput(
    structuredOutput ?? redactedOutputText,
    compiled.structuredOutputSchema ?? compiled.outputSchema,
    modelConfig.minReportWords,
  );
  return {
    segmentId: segment.id,
    outputText: redactedOutputText,
    reportText: reportText ?? undefined,
    memoryText:
      structuredOutput === undefined ? undefined : JSON.stringify(structuredOutput.memory),
    outputJson: structuredOutput === undefined ? validation.outputJson : structuredOutput.memory,
    schemaValid: validation.schemaValid,
    schemaErrors: validation.schemaErrors,
    attemptUsage,
  };
}

function usesOpenAiStructuredOutputSchema(modelConfig: AnalysisModelConfig): boolean {
  return ['openai', 'openai-compatible', 'gateway'].includes(modelConfig.provider);
}

function redactAndCanonicalizeStructuredOutput(
  output: unknown,
  evidence: readonly EvidenceMessage[],
  workspaceUrl: string,
  redactor: (text: string) => string,
): { readonly memory: unknown; readonly reportText: string } {
  const parsed = typeof output === 'string' ? extractStructuredJsonFromModelText(output) : output;
  const redacted = redactStructuredJsonValue(parsed, evidence, workspaceUrl, redactor);
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) {
    throw new Error('Structured model output must be a JSON object');
  }

  const memory = (redacted as { readonly memory?: unknown }).memory;
  const reportText = (redacted as { readonly reportText?: unknown }).reportText;

  return { memory, reportText: typeof reportText === 'string' ? reportText : '' };
}

function redactStructuredJsonValue(
  value: unknown,
  evidence: readonly EvidenceMessage[],
  workspaceUrl: string,
  redactor: (text: string) => string,
): unknown {
  if (typeof value === 'string') {
    return canonicalizeSlackEvidenceLinks(redactor(value), evidence, workspaceUrl);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredJsonValue(entry, evidence, workspaceUrl, redactor));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactStructuredJsonValue(entry, evidence, workspaceUrl, redactor),
      ]),
    );
  }

  return value;
}

function extractStructuredJsonFromModelText(text: string): unknown {
  return JSON.parse(text.trim());
}

function buildInvalidOutputRetryPrompt(originalPrompt: string, schemaErrors: unknown): string {
  return [
    originalPrompt,
    '# OUTPUT VALIDATION RETRY',
    [
      'Your previous response failed the required output JSON Schema validation.',
      'Produce a complete corrected structured JSON response now, including memory and a longer, more detailed reportText that satisfies every validation requirement.',
      'Do not summarize the previous response.',
      'Validation errors:',
    ].join(' '),
    '```json',
    JSON.stringify(schemaErrors),
    '```',
  ].join('\n\n');
}

function combineSegmentOutputs(outputs: readonly SegmentModelOutput[]): {
  readonly outputText: string;
  readonly reportText?: string | undefined;
  readonly memoryText?: string | undefined;
  readonly outputJson?: unknown;
  readonly schemaValid?: boolean | null | undefined;
  readonly schemaErrors?: unknown;
  readonly modelProvider?: string | undefined;
  readonly modelName?: string | undefined;
  readonly modelAttempts?: number | undefined;
  readonly modelCalls?: readonly ModelCallRecord[] | undefined;
  readonly usage?: ModelUsage | undefined;
} {
  if (outputs.length === 1) {
    const [output] = outputs;
    if (!output) {
      throw new Error('Cannot combine empty model output list');
    }
    return {
      outputText: output.outputText,
      reportText: output.reportText,
      memoryText: output.memoryText,
      outputJson: output.outputJson,
      schemaValid: output.schemaValid,
      schemaErrors: output.schemaErrors,
      modelProvider: output.modelProvider,
      modelName: output.modelName,
      modelAttempts: output.modelAttempts,
      modelCalls: output.modelCalls,
      usage: output.usage,
    };
  }

  const memoryJson = {
    segments: outputs
      .filter((output) => output.memoryText)
      .map((output) => ({
        segmentId: output.segmentId,
        content: output.memoryText,
      })),
  };
  const reportText = outputs
    .map((output) => {
      const report = output.reportText ?? output.outputText;
      return [`#### Segment ${output.segmentId}`, report.trim()].join('\n\n');
    })
    .join('\n\n');
  const modelCalls = outputs.flatMap((output) => output.modelCalls ?? []);
  const modelSummary = summarizeModelCalls(modelCalls);

  return {
    outputText: [
      JSON.stringify({
        memory: memoryJson,
        reportText,
      }),
    ].join('\n'),
    reportText,
    memoryText: JSON.stringify(memoryJson),
    outputJson: memoryJson,
    schemaValid: outputs.every((output) => output.schemaValid !== false),
    schemaErrors: outputs.flatMap((output) =>
      output.schemaErrors === undefined
        ? []
        : [{ segmentId: output.segmentId, errors: output.schemaErrors }],
    ),
    ...modelSummary,
    ...(modelCalls.length === 0 ? {} : { modelCalls }),
    usage: combineModelUsage(outputs.map((output) => output.usage)),
  };
}

function summarizeModelCalls(calls: readonly ModelCallRecord[]): {
  readonly modelProvider?: string | undefined;
  readonly modelName?: string | undefined;
  readonly modelAttempts?: number | undefined;
} {
  if (calls.length === 0) {
    return {};
  }

  const [first] = calls;
  const sameModel = calls.every(
    (call) => call.provider === first?.provider && call.model === first.model,
  );

  return {
    ...(sameModel ? { modelProvider: first?.provider, modelName: first?.model } : {}),
    modelAttempts: calls.reduce((total, call) => total + call.attempts, 0),
  };
}

function combineModelUsage(usages: readonly (ModelUsage | undefined)[]): ModelUsage | undefined {
  const present = usages.filter((usage) => usage !== undefined);
  if (present.length === 0) {
    return undefined;
  }

  const sum = (read: (usage: ModelUsage) => number | undefined) => {
    const values = present.map(read).filter((value) => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };

  return stripUndefined({
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
    totalTokens: sum((usage) => usage.totalTokens),
    reasoningTokens: sum((usage) => usage.reasoningTokens),
    cachedInputTokens: sum((usage) => usage.cachedInputTokens),
    inputTokenDetails: stripUndefined({
      noCacheTokens: sum((usage) => usage.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: sum((usage) => usage.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: sum((usage) => usage.inputTokenDetails?.cacheWriteTokens),
    }),
    outputTokenDetails: stripUndefined({
      textTokens: sum((usage) => usage.outputTokenDetails?.textTokens),
      reasoningTokens: sum((usage) => usage.outputTokenDetails?.reasoningTokens),
    }),
    raw: present.map((usage) => usage.raw).filter((rawUsage) => rawUsage !== undefined),
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entryValue]) => {
    if (entryValue === undefined) {
      return false;
    }
    return !Array.isArray(entryValue) || entryValue.length > 0;
  });
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries) as T;
}

function mergeSameRunMemory(
  previousMemory: string | null,
  segmentMemory: string | undefined,
): string | null {
  if (!segmentMemory) {
    return previousMemory;
  }

  const section = ['# CURRENT RUN SEGMENT MEMORY', segmentMemory].join('\n\n');
  return previousMemory ? [previousMemory, section].join('\n\n') : section;
}
