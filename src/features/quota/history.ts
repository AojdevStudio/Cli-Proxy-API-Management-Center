import type { QuotaHistoryBurn, QuotaHistoryRange } from '@/services/api/quotaHistoryContract';
import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';
import { poolLevelAt, type PoolCredential, type PoolPoint, type PoolProvider } from './pool';

export type BurnShortfall = Extract<QuotaHistoryBurn, { state: 'insufficient' }>['reason'];

export interface HistoryReading {
  observedAtMs: number;
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
  /** The first reading may predate the range when it is in force at its start. */
  readings: HistoryReading[];
  /** Spans with no reader run. */
  gaps: TimeSpan[];
  burn: LoginBurn;
}

export interface QuotaHistory {
  provider: PoolProvider;
  range: QuotaHistoryRange;
  fromMs: number;
  toMs: number;
  logins: ReadonlyMap<string, LoginHistory>;
}

export interface RecordedSegment {
  points: [PoolPoint, PoolPoint, ...PoolPoint[]];
  endInclusive: boolean;
}

type HistoryMember = Pick<PoolCredential, 'authIndex'>;

const RANGE_MS: Record<QuotaHistoryRange, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '14d': 14 * DAY_MS,
};

const RANGES = Object.keys(RANGE_MS) as QuotaHistoryRange[];

/** The reader stops vouching for a reading this long after the last run that wrote it. */
const CONFIRMATION_BOUND_MS = 30 * MINUTE_MS;

export const historyRangeFor = (startMs: number, nowMs: number): QuotaHistoryRange =>
  RANGES.find((range) => nowMs - RANGE_MS[range] <= startMs) ?? '14d';

const loginsOf = (history: QuotaHistory, members: readonly HistoryMember[]) =>
  members.map((member) =>
    member.authIndex === null ? undefined : history.logins.get(member.authIndex)
  );

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

  const segments: RecordedSegment[] = [];
  let open: RecordedSegment | null = null;
  for (let index = 0; index < times.length - 1; index += 1) {
    const atMs = times[index];
    const untilMs = times[index + 1];
    const level = poolLeftAt(logins, atMs);
    if (level === null) {
      if (open) open.endInclusive = false;
      open = null;
    } else if (open === null) {
      open = {
        points: [
          { atMs, poolPercent: level },
          { atMs: untilMs, poolPercent: level },
        ],
        endInclusive: true,
      };
      segments.push(open);
    } else if (open.points[open.points.length - 1].poolPercent === level) {
      open.points[open.points.length - 1].atMs = untilMs;
    } else {
      open.points.push({ atMs, poolPercent: level }, { atMs: untilMs, poolPercent: level });
    }
  }
  if (open) {
    const lastLevel = poolLeftAt(logins, toMs);
    if (lastLevel === null) open.endInclusive = false;
    else if (open.points[open.points.length - 1].poolPercent !== lastLevel) {
      open.points.push({ atMs: toMs, poolPercent: lastLevel });
    }
  }
  return segments;
}

export function recordedLevelAt(segments: readonly RecordedSegment[], atMs: number): number | null {
  const segment = segments.find(({ points, endInclusive }) => {
    const endMs = points[points.length - 1].atMs;
    return points[0].atMs <= atMs && (atMs < endMs || (endInclusive && atMs === endMs));
  });
  return segment ? poolLevelAt(segment.points, atMs) : null;
}

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
