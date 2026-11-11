/**
 * Recorded quota history for one provider's pool, as the usage reader measured
 * it, and the pool level and burn the Ledger draws from it.
 *
 * React-free and clock-free. services/api/usage.ts parses the wire body into
 * these types: times in epoch ms, utilization in percent.
 */

import type { QuotaHistoryBurn, QuotaHistoryRange } from '@/services/api/quotaHistoryContract';
import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';
import { poolLevelAt, type PoolCredential, type PoolPoint, type PoolProvider } from './pool';

export type BurnShortfall = Extract<QuotaHistoryBurn, { state: 'insufficient' }>['reason'];

export interface HistoryReading {
  observedAtMs: number;
  /** Weekly percent used, 0..100. */
  usedPercent: number;
  resetAtMs: number;
}

export interface TimeSpan {
  fromMs: number;
  toMs: number;
}

/** Percent points per hour, measured by the reader from every reading it holds. */
export type LoginBurn =
  | { state: 'measured'; percentPerHour: number; toMs: number }
  | { state: 'insufficient'; reason: BurnShortfall };

export interface LoginHistory {
  /**
   * Ascending by observedAtMs. The first can predate the range: it is the
   * reading in force at its start. Never empty when the burn is measured.
   */
  readings: HistoryReading[];
  /** Spans with no reader run, so the login's level there is unknown. Ascending. */
  gaps: TimeSpan[];
  burn: LoginBurn;
}

export interface QuotaHistory {
  provider: PoolProvider;
  range: QuotaHistoryRange;
  fromMs: number;
  toMs: number;
  /** By the gateway's hashed auth index, the only key a login joins on. */
  logins: ReadonlyMap<string, LoginHistory>;
}

/** A continuous step path of the pool's recorded level. A step is two points at one instant. */
export type RecordedSegment = readonly PoolPoint[];

/** A pool member as history sees it. A login with no auth index has no history. */
type HistoryMember = Pick<PoolCredential, 'authIndex'>;

const RANGE_MS: Record<QuotaHistoryRange, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '14d': 14 * DAY_MS,
};

const RANGES = Object.keys(RANGE_MS) as QuotaHistoryRange[];

/** The reader stops vouching for a reading this long after the last run that wrote it. */
const CONFIRMATION_BOUND_MS = 30 * MINUTE_MS;

/** The smallest range that reaches back to `startMs`. A DST week can run past seven days. */
export const historyRangeFor = (startMs: number, nowMs: number): QuotaHistoryRange =>
  RANGES.find((range) => nowMs - RANGE_MS[range] <= startMs) ?? '14d';

const loginsOf = (history: QuotaHistory, members: readonly HistoryMember[]) =>
  members.map((member) =>
    member.authIndex === null ? undefined : history.logins.get(member.authIndex)
  );

/** Index of the last item at or before `atMs`, or -1. Items ascend by `keyOf`. */
function lastAtOrBefore<T>(items: readonly T[], atMs: number, keyOf: (item: T) => number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (keyOf(items[mid]) <= atMs) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

/** Percent left at `atMs`, or null when no reading covers it. A passed reset reads full. */
function leftAt(login: LoginHistory, atMs: number): number | null {
  const gap = lastAtOrBefore(login.gaps, atMs, (span) => span.fromMs);
  if (gap >= 0 && atMs < login.gaps[gap].toMs) return null;
  const inForce = lastAtOrBefore(login.readings, atMs, (reading) => reading.observedAtMs);
  if (inForce < 0) return null;
  const reading = login.readings[inForce];
  return atMs >= reading.resetAtMs ? 100 : 100 - reading.usedPercent;
}

function poolLeftAt(logins: readonly LoginHistory[], atMs: number): number | null {
  let total = 0;
  for (const login of logins) {
    const left = leftAt(login, atMs);
    if (left === null) return null;
    total += left;
  }
  return total;
}

/**
 * The pool's recorded level from `startMs` to now, as step paths. The level is
 * known only where every member has a reading, so a gap or a member without
 * history breaks the path rather than reading as zero use.
 */
export function recordedPool(
  history: QuotaHistory,
  members: readonly HistoryMember[],
  startMs: number,
  nowMs: number
): RecordedSegment[] {
  const fromMs = Math.max(startMs, history.fromMs);
  const toMs = Math.min(nowMs, history.toMs);
  const logins = loginsOf(history, members);
  if (logins.length === 0 || fromMs >= toMs) return [];
  if (!logins.every((login): login is LoginHistory => login !== undefined)) return [];

  const edges = new Set([fromMs, toMs]);
  for (const login of logins) {
    for (const reading of login.readings) edges.add(reading.observedAtMs).add(reading.resetAtMs);
    for (const gap of login.gaps) edges.add(gap.fromMs).add(gap.toMs);
  }
  const times = [...edges].filter((at) => at >= fromMs && at <= toMs).sort((a, b) => a - b);

  const segments: PoolPoint[][] = [];
  let open: PoolPoint[] | null = null;
  for (let index = 0; index < times.length - 1; index += 1) {
    const atMs = times[index];
    const untilMs = times[index + 1];
    const level = poolLeftAt(logins, atMs);
    if (level === null) {
      open = null;
    } else if (open === null) {
      open = [
        { atMs, poolPercent: level },
        { atMs: untilMs, poolPercent: level },
      ];
      segments.push(open);
    } else if (open[open.length - 1].poolPercent === level) {
      open[open.length - 1].atMs = untilMs;
    } else {
      open.push({ atMs, poolPercent: level }, { atMs: untilMs, poolPercent: level });
    }
  }
  return segments;
}

/** The recorded level at `atMs`, or null where the record has no total. */
export function recordedLevelAt(segments: readonly RecordedSegment[], atMs: number): number | null {
  const segment = segments.find(
    (points) => points[0].atMs <= atMs && atMs <= points[points.length - 1].atMs
  );
  return segment ? poolLevelAt(segment, atMs) : null;
}

/**
 * The pool's burn in percent points per hour: the sum of every member's
 * measured rate. Null when any member has no current measured rate, since a
 * missing rate is unknown use, not zero use.
 */
export function poolBurn(
  history: QuotaHistory | null,
  members: readonly HistoryMember[],
  nowMs: number
): number | null {
  if (!history || members.length === 0) return null;
  let total = 0;
  for (const login of loginsOf(history, members)) {
    if (login?.burn.state !== 'measured') return null;
    if (nowMs - login.burn.toMs > CONFIRMATION_BOUND_MS) return null;
    if (nowMs >= login.readings[login.readings.length - 1].resetAtMs) return null;
    total += login.burn.percentPerHour;
  }
  return total;
}
