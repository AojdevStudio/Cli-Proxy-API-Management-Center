/** Usage-reader wire contract. Times are ISO 8601 UTC strings. */
export type QuotaHistoryProvider = 'claude' | 'codex';

export type QuotaHistoryRange = '24h' | '7d' | '14d';

export interface QuotaHistoryQuery {
  provider: QuotaHistoryProvider;
  range?: QuotaHistoryRange;
}

export type QuotaHistoryQueryError =
  'unknown_param' | 'missing_provider' | 'bad_provider' | 'bad_range';

export type QuotaHistoryBurn =
  | { state: 'measured'; percentPerHour: number; from: string; to: string }
  | {
      state: 'insufficient';
      reason: 'no_observations' | 'stale' | 'reset_passed' | 'too_short' | 'gap';
    };

export interface QuotaHistoryObservation {
  observedAt: string;
  /** Last run that wrote this reading, including repeated stale snapshots. */
  confirmedAt: string;
  /** Fraction of the weekly window used, from 0 to 1. */
  utilization: number;
  resetAt: string;
  windowSeconds: number;
  source: 'gateway' | 'usage_endpoint';
}

export interface QuotaHistoryAccount {
  authIndex: string;
  observations: QuotaHistoryObservation[];
  gaps: { from: string; to: string }[];
  burn: QuotaHistoryBurn;
}

export interface QuotaHistoryResponse {
  contract: 1;
  provider: QuotaHistoryProvider;
  range: QuotaHistoryRange;
  window: 'weekly';
  generatedAt: string;
  from: string;
  to: string;
  accounts: QuotaHistoryAccount[];
  coverage: {
    files: number;
    lines: number;
    malformedLines: number;
    unindexedLines: number;
    otherProviderLines: number;
    duplicatesDropped: number;
    conflictingDuplicates: number;
    unchangedCollapsed: number;
    oldestRunAt: string | null;
    newestRunAt: string | null;
  };
}
