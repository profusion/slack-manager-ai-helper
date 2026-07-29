import type { ScoreThresholds, SyntheticScoreRange } from '../types.js';

const defaultThresholds = {
  unrelatedBelow: 0.6,
  ambiguousFrom: 0.6,
  ambiguousBelow: 0.72,
  relatedFrom: 0.72,
};

export function classifyScore(
  score: number,
  config: { readonly thresholds?: ScoreThresholds | undefined } | undefined,
): SyntheticScoreRange {
  const thresholds = { ...defaultThresholds, ...config?.thresholds };
  if (score >= thresholds.relatedFrom) {
    return 'related';
  }

  if (score >= thresholds.ambiguousFrom && score < thresholds.ambiguousBelow) {
    return 'ambiguous';
  }

  return 'unrelated';
}
