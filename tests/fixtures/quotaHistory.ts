import type {
  QuotaHistoryAccount,
  QuotaHistoryBurn,
  QuotaHistoryObservation,
  QuotaHistoryProvider,
  QuotaHistoryRange,
  QuotaHistoryResponse,
} from '@/services/api/quotaHistoryContract';
import { usageApi } from '@/services/api/usage';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import { parsedBody } from './usagePanel';

export const NOW = Date.UTC(2026, 10, 11, 12);

const RANGE_MS: Record<QuotaHistoryRange, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '14d': 14 * DAY_MS,
};

const iso = (ms: number) => new Date(ms).toISOString();

export const observation = (
  observedAtMs: number,
  utilization: number,
  resetAtMs: number,
  confirmedAtMs = observedAtMs
): QuotaHistoryObservation => ({
  observedAt: iso(observedAtMs),
  confirmedAt: iso(confirmedAtMs),
  utilization,
  resetAt: iso(resetAtMs),
  windowSeconds: 604_800,
  source: 'gateway',
});

export const measured = (percentPerHour: number, toMs: number): QuotaHistoryBurn => ({
  state: 'measured',
  percentPerHour,
  from: iso(toMs - 3 * HOUR_MS),
  to: iso(toMs),
});

export const NO_BURN: QuotaHistoryBurn = { state: 'insufficient', reason: 'too_short' };

export const account = (
  authIndex: string,
  observations: QuotaHistoryObservation[],
  { gaps = [], burn = NO_BURN }: { gaps?: [number, number][]; burn?: QuotaHistoryBurn } = {}
): QuotaHistoryAccount => ({
  authIndex,
  observations,
  gaps: gaps.map(([from, to]) => ({ from: iso(from), to: iso(to) })),
  burn,
});

export const historyBody = (
  accounts: QuotaHistoryAccount[],
  {
    provider = 'claude',
    range = '7d',
    toMs = NOW,
  }: { provider?: QuotaHistoryProvider; range?: QuotaHistoryRange; toMs?: number } = {}
): QuotaHistoryResponse => ({
  contract: 1,
  provider,
  range,
  window: 'weekly',
  generatedAt: iso(toMs),
  from: iso(toMs - RANGE_MS[range]),
  to: iso(toMs),
  accounts,
  coverage: {
    files: 1,
    lines: 10,
    malformedLines: 0,
    unindexedLines: 0,
    otherProviderLines: 0,
    duplicatesDropped: 0,
    conflictingDuplicates: 0,
    unchangedCollapsed: 0,
    oldestRunAt: null,
    newestRunAt: null,
  },
});

export const parseHistory = (body: QuotaHistoryResponse) =>
  parsedBody(body, () => usageApi.quotaHistory({ provider: body.provider, range: body.range }));
