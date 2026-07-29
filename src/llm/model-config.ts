import type { AnalysisModelConfig } from '../types.js';

export const defaultModelRetries = 3;

export function analysisModelChain(
  modelConfig: AnalysisModelConfig,
): readonly AnalysisModelConfig[] {
  const chain: AnalysisModelConfig[] = [];
  let current: AnalysisModelConfig | undefined = modelConfig;
  while (current) {
    chain.push(current);
    current = current.fallback;
  }
  return chain;
}

export function retryCountForModel(modelConfig: AnalysisModelConfig): number {
  return modelConfig.retries ?? defaultModelRetries;
}

export function effectiveContextWindowTokens(modelConfig: AnalysisModelConfig): number | undefined {
  const windows = analysisModelChain(modelConfig)
    .map((model) => model.contextWindowTokens)
    .filter((value): value is number => value !== undefined);
  return windows.length === 0 ? undefined : Math.min(...windows);
}

export function effectiveReservedOutputTokens(modelConfig: AnalysisModelConfig): number {
  return Math.max(...analysisModelChain(modelConfig).map((model) => model.maxOutputTokens ?? 4096));
}
