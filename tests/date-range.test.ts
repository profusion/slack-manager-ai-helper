import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeDateRange } from '../src/date-range.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeDateRange', () => {
  it('resolves today and yesterday in the provided local timezone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-06T02:00:00.000Z'));

    expect(normalizeDateRange({ date: 'today' }, 'America/Sao_Paulo')).toEqual({
      startDate: '2026-06-05',
      endDate: '2026-06-05',
    });
    expect(normalizeDateRange({ date: 'yesterday' }, 'America/Sao_Paulo')).toEqual({
      startDate: '2026-06-04',
      endDate: '2026-06-04',
    });
  });

  it('resolves workday windows from a weekend invocation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-06T15:00:00.000Z'));

    expect(normalizeDateRange({ window: 'current-workday' }, 'America/Sao_Paulo')).toEqual({
      startDate: '2026-06-05',
      endDate: '2026-06-05',
    });
    expect(normalizeDateRange({ window: 'previous-workday' }, 'America/Sao_Paulo')).toEqual({
      startDate: '2026-06-05',
      endDate: '2026-06-05',
    });
    expect(normalizeDateRange({ window: 'previous-5-workdays' }, 'America/Sao_Paulo')).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-05',
    });
  });

  it('rejects mutually exclusive date inputs', () => {
    expect(() =>
      normalizeDateRange({
        date: 'today',
        startDate: '2026-06-01',
      }),
    ).toThrow('--date is mutually exclusive');
    expect(() =>
      normalizeDateRange({
        window: 'current-workday',
        endDate: '2026-06-01',
      }),
    ).toThrow('--window is mutually exclusive');
  });

  it('rejects unknown aliases and windows', () => {
    expect(() => normalizeDateRange({ date: 'tomorrow' }, 'America/Sao_Paulo')).toThrow(
      'Invalid date',
    );
    expect(() => normalizeDateRange({ window: 'current-week' }, 'America/Sao_Paulo')).toThrow(
      'Invalid window',
    );
  });
});
