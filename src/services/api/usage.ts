/**
 * Usage reader client. The only file that knows the relay, the reader URL, and
 * the wire shape. The reader listens on the mini's loopback, so the browser
 * reaches it through CPA's api-call relay, never directly.
 *
 * Every body is parsed once here: rendered fields only, timestamps to epoch ms,
 * labels stripped of emails. Past this file the page trusts the types.
 */

import { apiCallApi, type ApiCallResult } from './apiCall';
import { getStatusFromError } from '@/utils/quota';
import { isRecord } from '@/utils/helpers';
import {
  READER_CONTRACT,
  type BreakdownRow,
  type ReaderHealth,
  type Reported,
  type SessionList,
  type SessionSummary,
  type SessionTurn,
  type Totals,
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

const bool = (value: unknown, path: string): boolean =>
  typeof value === 'boolean' ? value : fail(path, 'boolean');

const instant = (value: unknown, path: string): number => {
  const ms = Date.parse(str(value, path));
  return Number.isFinite(ms) ? ms : fail(path, 'ISO 8601 time');
};

const instantOrNull = (value: unknown, path: string): number | null =>
  value === null ? null : instant(value, path);

const list = <T>(value: unknown, path: string, item: (v: unknown, p: string) => T): T[] =>
  Array.isArray(value) ? value.map((v, i) => item(v, `${path}[${i}]`)) : fail(path, 'array');

const label = (value: unknown, path: string): string => stripEmails(str(value, path));

const parseReported = (value: unknown, path: string): Reported => {
  const r = record(value, path);
  return {
    sum: num(r.sum, `${path}.sum`),
    rowsReporting: num(r.rowsReporting, `${path}.rowsReporting`),
  };
};

const parseTotals = (value: unknown, path: string): Totals => {
  const r = record(value, path);
  return {
    requests: num(r.requests, `${path}.requests`),
    failed: num(r.failed, `${path}.failed`),
    tokens: num(r.tokens, `${path}.tokens`),
    freshInput: num(r.freshInput, `${path}.freshInput`),
    cacheRead: num(r.cacheRead, `${path}.cacheRead`),
    cacheWrite: num(r.cacheWrite, `${path}.cacheWrite`),
    output: num(r.output, `${path}.output`),
    reasoning: parseReported(r.reasoning, `${path}.reasoning`),
    latencyMsP50: numOrNull(r.latencyMsP50, `${path}.latencyMsP50`),
  };
};

const parseBreakdownRow = (value: unknown, path: string): BreakdownRow => {
  const r = record(value, path);
  return {
    key: str(r.key, `${path}.key`),
    label: label(r.label, `${path}.label`),
    totals: parseTotals(r.totals, `${path}.totals`),
  };
};

const parseOverview = (body: Record<string, unknown>): UsageOverview => {
  const series = record(body.series, 'series');
  const breakdown = record(body.breakdown, 'breakdown');
  const coverage = record(body.coverage, 'coverage');
  const buckets = list(series.buckets, 'series.buckets', instant);
  const perBucket = <T>(values: T[], path: string): T[] =>
    values.length === buckets.length ? values : fail(path, `${buckets.length} values`);
  const baseline = body.baseline === null ? null : record(body.baseline, 'baseline');
  return {
    to: instant(body.to, 'to'),
    totals: parseTotals(body.totals, 'totals'),
    series: {
      buckets,
      bucketTokens: perBucket(
        list(series.bucketTotals, 'series.bucketTotals', (value, path) =>
          num(record(value, path).tokens, `${path}.tokens`)
        ),
        'series.bucketTotals'
      ),
      groups: list(series.groups, 'series.groups', (value, path) => {
        const g = record(value, path);
        const tokens = perBucket(list(g.tokens, `${path}.tokens`, num), `${path}.tokens`);
        return { key: str(g.key, `${path}.key`), label: label(g.label, `${path}.label`), tokens };
      }),
    },
    breakdown: {
      client: list(breakdown.client, 'breakdown.client', parseBreakdownRow),
      model: list(breakdown.model, 'breakdown.model', parseBreakdownRow),
      account: list(breakdown.account, 'breakdown.account', parseBreakdownRow),
    },
    coverage: {
      oldestAt: instantOrNull(coverage.oldestAt, 'coverage.oldestAt'),
      rangeFullyCovered: bool(coverage.rangeFullyCovered, 'coverage.rangeFullyCovered'),
      unparsedLines: num(coverage.unparsedLines, 'coverage.unparsedLines'),
      truncatedOldest: bool(coverage.truncatedOldest, 'coverage.truncatedOldest'),
    },
    baseline: baseline && {
      tokensSameTimeAvg7d: numOrNull(baseline.tokensSameTimeAvg7d, 'baseline.tokensSameTimeAvg7d'),
      failRate7d: numOrNull(baseline.failRate7d, 'baseline.failRate7d'),
    },
  };
};

const parseSessionSummary = (value: unknown, path: string): SessionSummary => {
  const r = record(value, path);
  return {
    id: str(r.id, `${path}.id`),
    sessionId: str(r.sessionId, `${path}.sessionId`),
    client: label(r.client, `${path}.client`),
    models: list(r.models, `${path}.models`, label),
    firstAt: instant(r.firstAt, `${path}.firstAt`),
    lastAt: instant(r.lastAt, `${path}.lastAt`),
    turns: num(r.turns, `${path}.turns`),
    lastPrompt: num(r.lastPrompt, `${path}.lastPrompt`),
    peakPrompt: num(r.peakPrompt, `${path}.peakPrompt`),
    totals: parseTotals(r.totals, `${path}.totals`),
  };
};

/** Turns arrive ordered by event time (the reader sorts them). */
const parseTurns = (body: Record<string, unknown>): SessionTurn[] =>
  list(body.turns, 'turns', (value, path) => {
    const r = record(value, path);
    return {
      at: instant(r.at, `${path}.at`),
      freshInput: num(r.freshInput, `${path}.freshInput`),
      cacheRead: num(r.cacheRead, `${path}.cacheRead`),
      cacheWrite: num(r.cacheWrite, `${path}.cacheWrite`),
    };
  });

/** Sessions arrive biggest first by tokens, at most 100 of sessionCount. */
const parseSessions = (body: Record<string, unknown>): SessionList => ({
  sessions: list(body.sessions, 'sessions', parseSessionSummary),
  sessionCount: num(body.sessionCount, 'sessionCount'),
});

const parseHealth = (body: Record<string, unknown>): ReaderHealth => ({
  unparsedLines: num(body.unparsedLines, 'unparsedLines'),
  duplicateKeysDropped: num(body.duplicateKeysDropped, 'duplicateKeysDropped'),
  collectorHeartbeatAt: instantOrNull(
    record(body.collector, 'collector').heartbeatAt,
    'collector.heartbeatAt'
  ),
});

/** Status codes that mean the relay could not reach the reader at all. */
const READER_DOWN_STATUSES = new Set([0, 502]);

/** Maps one relay result to a UsageResult. Pure, so the api test drives it directly. */
export function interpretReaderResponse<T>(
  result: Pick<ApiCallResult, 'statusCode' | 'body'>,
  parse: (body: Record<string, unknown>) => T
): UsageResult<T> {
  const { statusCode, body } = result;
  if (READER_DOWN_STATUSES.has(statusCode)) {
    return { status: 'offline', reason: { kind: 'reader-down' } };
  }
  try {
    if (statusCode === 503 && isRecord(body) && body.state === 'warming') {
      return { status: 'warming', rowsLoaded: num(body.rowsLoaded, 'rowsLoaded') };
    }
    // The reader is up but its last log sync failed. The reason names the failure.
    if (statusCode === 503 && isRecord(body) && body.state === 'unavailable') {
      return {
        status: 'offline',
        reason: { kind: 'reader-failed', detail: label(body.reason, 'reason') },
      };
    }
    if (statusCode !== 200) {
      return { status: 'offline', reason: { kind: 'relay-refused', status: statusCode } };
    }
    const r = record(body, 'body');
    if (r.contract !== READER_CONTRACT) {
      return { status: 'offline', reason: { kind: 'contract-mismatch', got: r.contract } };
    }
    return { status: 'ready', data: parse(r) };
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
  overview: (range: UsageRange) =>
    readerGet(`/v1/overview?range=${range}&groupBy=provider`, parseOverview),
  sessions: (range: UsageRange) => readerGet(`/v1/sessions?range=${range}`, parseSessions),
  sessionTurns: (id: string) => readerGet(`/v1/sessions/${encodeURIComponent(id)}`, parseTurns),
};
