import type { AppConfig } from '../types.js';

export type TokenEstimate = {
  readonly tokens: number;
  readonly method: 'openai-family-estimate' | 'conservative-char-estimate';
};

export function estimateModelTokens(
  text: string,
  modelConfig: Pick<AppConfig['model'], 'provider' | 'model'>,
): TokenEstimate {
  if (isOpenAiFamily(modelConfig)) {
    return {
      tokens: estimateFromCharacters(text, 4),
      method: 'openai-family-estimate',
    };
  }

  return {
    tokens: estimateFromCharacters(text, 3),
    method: 'conservative-char-estimate',
  };
}

export function tokenSafetyMargin(method: TokenEstimate['method']): number {
  return method === 'openai-family-estimate' ? 1.25 : 1.4;
}

function isOpenAiFamily(modelConfig: Pick<AppConfig['model'], 'provider' | 'model'>): boolean {
  const provider = modelConfig.provider.toLowerCase();
  if (['openai', 'openai-compatible'].includes(provider)) {
    return true;
  }

  if (provider !== 'openrouter' && provider !== 'gateway') {
    return false;
  }

  const model = modelConfig.model.toLowerCase();
  return /(?:^|[/:-])(?:gpt-|o\d|chatgpt-|openai)/u.test(model);
}

function estimateFromCharacters(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}
