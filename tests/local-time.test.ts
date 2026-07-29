import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logger.js';
import {
  formatDateForLlm,
  formatSlackTimestampForLlm,
  resolveLocalTimeZone,
} from '../src/utils/local-time.js';

describe('local LLM timestamps', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('formats dates with the timezone offset from TZ', () => {
    expect(formatDateForLlm(new Date('2026-06-02T15:34:56Z'), 'America/Sao_Paulo')).toBe(
      '20260602T12:34:56-0300',
    );
  });

  it('formats Slack timestamps as local ISO-style timestamps', () => {
    expect(formatSlackTimestampForLlm('1780414496', 'America/Sao_Paulo')).toBe(
      '20260602T12:34:56-0300',
    );
  });

  it('warns when TZ is unset', () => {
    vi.stubEnv('TZ', '');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(resolveLocalTimeZone()).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackTimeZone: expect.any(String) }),
      'TZ is unset; using system local timezone',
    );
  });
});
