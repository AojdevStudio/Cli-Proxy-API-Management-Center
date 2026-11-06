/**
 * Usage reader client. The only file that knows the relay, the reader URL, and
 * the wire shape. The reader listens on the mini's loopback, so the browser
 * reaches it through CPA's api-call relay, never directly.
 *
 * Every body is parsed once here. Past this file the page trusts the types.
 * Labels lose any email here too, so no email can reach the page.
 */

import { apiCallApi, type ApiCallResult } from './apiCall';
import { getStatusFromError } from '@/utils/quota';
import { isRecord } from '@/utils/helpers';
import {
  READER_CONTRACT,
  type Baseline,
  type BreakdownRow,
  type Cost,
  type Coverage,
  type ReaderHealth,
  type Reported,
  type SessionSummary,
  type SessionTurn,
  type SessionTurns,
  type Totals,
  type UsageBucket,
  type UsageOverview,
  type UsageRange,
  type UsageResult,
} from '@/features/usage/types';

export const READER_URL = 'http://127.0.0.1:8327';

const EMAIL_PATTERN = /[^\s@]*@[^\s@]*/g;

/** Removes anything shaped like an email, then any stray `@`. */
export const stripEmails = (text: string): string =>
  text.replace(EMAIL_PATTERN, ' ').replace(/@/g, ' ').replace(/\s+/g, ' ').trim();

class ShapeError extends Error {}

const fail = (path: string, expected: string): never => {
  throw new ShapeError(`${path}: expected ${expected}`);
};

const record = (value: unknown, path: string): Record<string, unknown> =>
  isRecord(value) ? value : fail(path, 'object');

const num = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'number');

const numOrNull = (value: unknown, path: string): number | null =>
  value === null ? null : num(value, path);

const str = (value: unknown, path: string): string =>
  typeof value === 'string' ? value : fail(path, 'string');

const strOrNull = (value: unknown, path: string): string | null =>
  value === null ? null : str(value, path);

const bool = (value: unknown, path: string): boolean =>
  typeof value === 'boolean' ? value : fail(path, 'boolean');

const list = <T>(value: unknown, path: string, item: (v: unknown, p: string) => T): T[] =>
  Array.isArray(value) ? value.map((v, i) => item(v, `${path}[${i}]`)) : fail(path, 'array');

const label = (value: unknown, path: string): string => stripEmails(str(value, path));

const parseReported = (value: unknown, path: string): Reported => {
  const r = record(value, path);
  return { sum: num(r.sum, `${path}.sum`), rowsReporting: num(r.rowsReporting, `${path}.rowsReporting`) };
};

const parseTotals = (value: unknown, path: string): Totals => {
  const r = record(value, path);
  return {
    requests: num(r.requests, `${path}.requests`),
    failed: num(r.failed, `${path}.failed`),
    freshInput: num(r.freshInput, `${path}.freshInput`),
    cacheRead: num(r.cacheRead, `${path}.cacheRead`),
    cacheWrite: num(r.cacheWrite, `${path}.cacheWrite`),
    output: num(r.output, `${path}.output`),
    reasoning: parseReported(r.reasoning, `${path}.reasoning`),
    latencyMsP50: numOrNull(r.latencyMsP50, `${path}.latencyMsP50`),
  };
};

const parseCost = (value: unknown, path: string): Cost => {
  const r = record(value, path);
  return {
    billedUsd: parseReported(r.billedUsd, `${path}.billedUsd`),
    estimateUsd: numOrNull(r.estimateUsd, `${path}.estimateUsd`),
    pricedShare: num(r.pricedShare, `${path}.pricedShare`),
    priceBookDate: strOrNull(r.priceBookDate, `${path}.priceBookDate`),
    unpricedModels: list(r.unpricedModels, `${path}.unpricedModels`, label),
  };
};

const parseBreakdownRow = (value: unknown, path: string): BreakdownRow => {
  const r = record(value, path);
  return {
    key: str(r.key, `${path}.key`),
    label: label(r.label, `${path}.label`),
    totals: parseTotals(r.totals, `${path}.totals`),
    cost: parseCost(r.cost, `${path}.cost`),
  };
};

const parseCoverage = (value: unknown, path: string): Coverage => {
  const r = record(value, path);
  return {
    oldestAt: str(r.oldestAt, `${path}.oldestAt`),
    newestAt: str(r.newestAt, `${path}.newestAt`),
    rangeFullyCovered: bool(r.rangeFullyCovered, `${path}.rangeFullyCovered`),
    unparsedLines: num(r.unparsedLines, `${path}.unparsedLines`),
    truncatedOldest: bool(r.truncatedOldest, `${path}.truncatedOldest`),
  };
};

const parseBaseline = (value: unknown, path: string): Baseline | null => {
  if (value === null) return null;
  const r = record(value, path);
  return {
    tokensSameTimeAvg7d: numOrNull(r.tokensSameTimeAvg7d, `${path}.tokensSameTimeAvg7d`),
    requestsSameTimeAvg7d: numOrNull(r.requestsSameTimeAvg7d, `${path}.requestsSameTimeAvg7d`),
    failRate7d: numOrNull(r.failRate7d, `${path}.failRate7d`),
  };
};

const RANGES: readonly UsageRange[] = ['today', '7d'];
const BUCKETS: readonly UsageBucket[] = ['hour', '6h', 'day'];

const oneOf = <T extends string>(value: unknown, path: string, allowed: readonly T[]): T =>
  allowed.find((candidate) => candidate === value) ?? fail(path, allowed.join(' | '));

const parseOverview = (body: Record<string, unknown>): UsageOverview => {
  const series = record(body.series, 'series');
  const breakdown = record(body.breakdown, 'breakdown');
  const buckets = list(series.buckets, 'series.buckets', str);
  return {
    range: oneOf(body.range, 'range', RANGES),
    bucket: oneOf(body.bucket, 'bucket', BUCKETS),
    groupBy: str(body.groupBy, 'groupBy'),
    from: str(body.from, 'from'),
    to: str(body.to, 'to'),
    totals: parseTotals(body.totals, 'totals'),
    cost: parseCost(body.cost, 'cost'),
    series: {
      buckets,
      groups: list(series.groups, 'series.groups', (value, path) => {
        const g = record(value, path);
        const tokens = list(g.tokens, `${path}.tokens`, num);
        if (tokens.length !== buckets.length) fail(`${path}.tokens`, `${buckets.length} values`);
        return { key: str(g.key, `${path}.key`), label: label(g.label, `${path}.label`), tokens };
      }),
    },
    breakdown: {
      client: list(breakdown.client, 'breakdown.client', parseBreakdownRow),
      model: list(breakdown.model, 'breakdown.model', parseBreakdownRow),
      account: list(breakdown.account, 'breakdown.account', parseBreakdownRow),
    },
    coverage: parseCoverage(body.coverage, 'coverage'),
    baseline: parseBaseline(body.baseline ?? null, 'baseline'),
  };
};

const parseSessionSummary = (value: unknown, path: string): SessionSummary => {
  const r = record(value, path);
  return {
    id: str(r.id, `${path}.id`),
    parentId: strOrNull(r.parentId, `${path}.parentId`),
    childCount: num(r.childCount, `${path}.childCount`),
    client: label(r.client, `${path}.client`),
    models: list(r.models, `${path}.models`, label),
    firstAt: str(r.firstAt, `${path}.firstAt`),
    lastAt: str(r.lastAt, `${path}.lastAt`),
    turns: num(r.turns, `${path}.turns`),
    lastPrompt: num(r.lastPrompt, `${path}.lastPrompt`),
    peakPrompt: num(r.peakPrompt, `${path}.peakPrompt`),
    contextWindow: numOrNull(r.contextWindow, `${path}.contextWindow`),
    totals: parseTotals(r.totals, `${path}.totals`),
  };
};

const parseSessions = (body: Record<string, unknown>): SessionSummary[] =>
  list(body.sessions, 'sessions', parseSessionSummary);

const parseTurn = (value: unknown, path: string): SessionTurn => {
  const r = record(value, path);
  return {
    at: str(r.at, `${path}.at`),
    model: label(r.model, `${path}.model`),
    freshInput: num(r.freshInput, `${path}.freshInput`),
    cacheRead: num(r.cacheRead, `${path}.cacheRead`),
    cacheWrite: num(r.cacheWrite, `${path}.cacheWrite`),
    output: num(r.output, `${path}.output`),
    failed: bool(r.failed, `${path}.failed`),
  };
};

const parseSessionTurns = (body: Record<string, unknown>): SessionTurns => ({
  session: parseSessionSummary(body.session, 'session'),
  contextWindow: numOrNull(body.contextWindow, 'contextWindow'),
  downsampled: bool(body.downsampled, 'downsampled'),
  turns: list(body.turns, 'turns', parseTurn),
  compactions: list(body.compactions, 'compactions', num),
});

const parseHealth = (body: Record<string, unknown>): ReaderHealth => ({
  state: oneOf(body.state, 'state', ['ready'] as const),
  rows: num(body.rows, 'rows'),
  files: num(body.files, 'files'),
  oldestAt: str(body.oldestAt, 'oldestAt'),
  newestAt: str(body.newestAt, 'newestAt'),
  unparsedLines: num(body.unparsedLines, 'unparsedLines'),
  duplicateKeysDropped: num(body.duplicateKeysDropped, 'duplicateKeysDropped'),
  collectorHeartbeatAt: strOrNull(body.collectorHeartbeatAt ?? null, 'collectorHeartbeatAt'),
});

/** Status codes that mean the relay could not reach the reader at all. */
const READER_DOWN_STATUSES = new Set([0, 502]);

/** Maps one relay result to a UsageResult. Pure, so the api test drives it directly. */
export function interpretReaderResponse<T>(
  result: Pick<ApiCallResult, 'statusCode' | 'body'>,
  parse: (body: Record<string, unknown>) => T
): UsageResult<T> {
  const { statusCode, body } = result;
  if (READER_DOWN_STATUSES.has(statusCode)) return { status: 'offline', reason: { kind: 'reader-down' } };
  if (statusCode === 503 && isRecord(body) && body.state === 'warming') {
    const rowsLoaded = typeof body.rowsLoaded === 'number' ? body.rowsLoaded : 0;
    return { status: 'warming', rowsLoaded };
  }
  if (statusCode !== 200) {
    return { status: 'offline', reason: { kind: 'relay-refused', status: statusCode } };
  }
  if (!isRecord(body)) {
    return { status: 'offline', reason: { kind: 'bad-response', detail: 'body is not a JSON object' } };
  }
  if (body.contract !== READER_CONTRACT) {
    return { status: 'offline', reason: { kind: 'contract-mismatch', got: body.contract } };
  }
  try {
    return { status: 'ready', data: parse(body) };
  } catch (err: unknown) {
    if (err instanceof ShapeError) {
      return { status: 'offline', reason: { kind: 'bad-response', detail: err.message } };
    }
    throw err;
  }
}

async function readerGet<T>(
  path: string,
  parse: (body: Record<string, unknown>) => T
): Promise<UsageResult<T>> {
  let result: ApiCallResult;
  try {
    result = await apiCallApi.request({ method: 'GET', url: `${READER_URL}${path}` });
  } catch (err: unknown) {
    // The management API answered the relay call itself with an error.
    const status = getStatusFromError(err) ?? 0;
    return READER_DOWN_STATUSES.has(status)
      ? { status: 'offline', reason: { kind: 'reader-down' } }
      : { status: 'offline', reason: { kind: 'relay-refused', status } };
  }
  return interpretReaderResponse(result, parse);
}

export const usageApi = {
  health: () => readerGet('/v1/health', parseHealth),
  overview: (range: UsageRange) => readerGet(`/v1/overview?range=${range}&groupBy=provider`, parseOverview),
  sessions: (range: UsageRange) => readerGet(`/v1/sessions?range=${range}`, parseSessions),
  session: (id: string) => readerGet(`/v1/sessions/${encodeURIComponent(id)}`, parseSessionTurns),
};
