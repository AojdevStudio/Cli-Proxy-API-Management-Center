/**
 * Usage reader domain types. Same shapes as reader contract 1 plus the
 * 2026-11-06 addendum, after the API edge in services/api/usage.ts has parsed
 * them. Every label here has already had emails stripped at that edge.
 */

export const READER_CONTRACT = 1;

export type UsageRange = 'today' | '7d';
export type UsageBucket = 'hour' | '6h' | 'day';

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

export interface Cost {
  billedUsd: Reported;
  estimateUsd: number | null;
  pricedShare: number;
  priceBookDate: string | null;
  unpricedModels: string[];
}

export interface BreakdownRow {
  key: string;
  label: string;
  totals: Totals;
  cost: Cost;
}

export interface SeriesGroup {
  key: string;
  label: string;
  tokens: number[];
}

export interface Baseline {
  tokensSameTimeAvg7d: number | null;
  requestsSameTimeAvg7d: number | null;
  failRate7d: number | null;
}

export interface Coverage {
  oldestAt: string;
  newestAt: string;
  rangeFullyCovered: boolean;
  unparsedLines: number;
  truncatedOldest: boolean;
}

export interface UsageOverview {
  range: UsageRange;
  bucket: UsageBucket;
  groupBy: string;
  from: string;
  to: string;
  totals: Totals;
  cost: Cost;
  series: { buckets: string[]; groups: SeriesGroup[] };
  breakdown: Record<'client' | 'model' | 'account', BreakdownRow[]>;
  coverage: Coverage;
  baseline: Baseline | null;
}

export interface SessionSummary {
  id: string;
  parentId: string | null;
  childCount: number;
  client: string;
  models: string[];
  firstAt: string;
  lastAt: string;
  turns: number;
  lastPrompt: number;
  peakPrompt: number;
  contextWindow: number | null;
  totals: Totals;
}

export interface SessionTurn {
  at: string;
  model: string;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  failed: boolean;
}

export interface SessionTurns {
  session: SessionSummary;
  contextWindow: number | null;
  downsampled: boolean;
  turns: SessionTurn[];
  compactions: number[];
}

export interface ReaderHealth {
  state: 'ready';
  rows: number;
  files: number;
  oldestAt: string;
  newestAt: string;
  unparsedLines: number;
  duplicateKeysDropped: number;
  collectorHeartbeatAt: string | null;
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
