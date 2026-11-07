/**
 * Usage reader domain types: the subset of reader contract 1 (plus the
 * 2026-11-06 addendum) that the page renders, after services/api/usage.ts has
 * parsed it. Times are epoch ms. Labels have already lost any email.
 * A field joins these types when a view reads it, so a contract change to an
 * unread field (cost, for one) cannot take the page offline.
 */

export const READER_CONTRACT = 1;

export type UsageRange = 'today' | '7d';

/** A field only some rows report. rowsReporting 0 means the panel shows "n/a". */
export interface Reported {
  sum: number;
  rowsReporting: number;
}

export interface Totals {
  requests: number;
  failed: number;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: Reported;
  latencyMsP50: number | null;
}

export interface BreakdownRow {
  key: string;
  label: string;
  totals: Totals;
}

interface SeriesGroup {
  key: string;
  label: string;
  tokens: number[];
}

export interface UsageOverview {
  to: number;
  totals: Totals;
  series: { buckets: number[]; groups: SeriesGroup[] };
  breakdown: Record<'client' | 'model' | 'account', BreakdownRow[]>;
  coverage: {
    oldestAt: number;
    rangeFullyCovered: boolean;
    unparsedLines: number;
    truncatedOldest: boolean;
  };
  baseline: { tokensSameTimeAvg7d: number | null; failRate7d: number | null } | null;
}

export interface SessionSummary {
  id: string;
  client: string;
  models: string[];
  firstAt: number;
  lastAt: number;
  turns: number;
  lastPrompt: number;
  peakPrompt: number;
  totals: Totals;
}

export interface SessionTurn {
  at: number;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ReaderHealth {
  unparsedLines: number;
  duplicateKeysDropped: number;
  collectorHeartbeatAt: number | null;
}

export type OfflineReason =
  | { kind: 'reader-down' }
  | { kind: 'relay-refused'; status: number }
  | { kind: 'contract-mismatch'; got: unknown }
  | { kind: 'bad-response'; detail: string };

export type UsageResult<T> =
  | { status: 'ready'; data: T }
  | { status: 'warming'; rowsLoaded: number }
  | { status: 'offline'; reason: OfflineReason };

/** Everything the page needs from the reader in one load. */
export interface ReaderSnapshot {
  health: ReaderHealth;
  today: UsageOverview;
  week: UsageOverview;
  sessions: SessionSummary[];
}
