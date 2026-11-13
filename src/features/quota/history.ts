import type { QuotaHistoryRange } from '@/services/api/quotaHistoryContract';
import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { poolLevelAt, type PoolCredential, type PoolPoint, type PoolProvider } from './pool';

export interface HistoryReading {
  observedAtMs: number;
  /** The last reader run that wrote this reading. */
  confirmedAtMs: number;
  usedPercent: number;
  resetAtMs: number;
}

export interface TimeSpan {
  fromMs: number;
  toMs: number;
}

export interface LoginHistory {
  /** The first reading may predate the range when it is in force at its start. */
  readings: HistoryReading[];
  /** Spans with no reader run. */
  gaps: TimeSpan[];
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

/** The reader stops vouching for a reading this long after the last run that wrote it. */
const CONFIRMATION_BOUND_MS = 30 * MINUTE_MS;

/** A burn measured from a reset needs this much time after it to mean anything. */
const MIN_SINCE_RESET_MS = 30 * MINUTE_MS;

export const DRAIN_SAMPLE_MS = 30 * MINUTE_MS;

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

const readingIndexAt = (login: LoginHistory, atMs: number) =>
  lastAtOrBefore(login.readings, atMs, (reading) => reading.observedAtMs);

const usedOf = (reading: HistoryReading, atMs: number) =>
  atMs >= reading.resetAtMs ? 0 : reading.usedPercent;

function leftAt(login: LoginHistory, atMs: number): number | null {
  const gap = lastAtOrBefore(login.gaps, atMs, (span) => span.fromMs);
  if (gap >= 0 && atMs < login.gaps[gap].toMs) return null;
  const inForce = readingIndexAt(login, atMs);
  if (inForce < 0) return null;
  return 100 - usedOf(login.readings[inForce], atMs);
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

/**
 * One login's burn over [startMs, nowMs] in percent points per hour. A reset
 * while its reading is in force restarts the measure at the reset, with
 * nothing used yet. Used that falls any other way, such as an early reset,
 * leaves the window unmeasurable.
 */
function loginBurn(login: LoginHistory, startMs: number, nowMs: number): number | null {
  const gap = lastAtOrBefore(login.gaps, nowMs - 1, (span) => span.fromMs);
  if (gap >= 0 && login.gaps[gap].toMs > startMs) return null;
  const first = readingIndexAt(login, startMs);
  const last = readingIndexAt(login, nowMs);
  if (first < 0) return null;
  if (nowMs - login.readings[last].confirmedAtMs > CONFIRMATION_BOUND_MS) return null;

  let fromMs = startMs;
  let fromUsed = 0;
  let usedSoFar = 0;
  for (let index = first; index <= last; index += 1) {
    const reading = login.readings[index];
    const inForceFromMs = Math.max(startMs, reading.observedAtMs);
    const inForceUntilMs = index < last ? login.readings[index + 1].observedAtMs : nowMs;
    const used = usedOf(reading, inForceFromMs);
    if (index === first) fromUsed = used;
    else if (used < usedSoFar) return null;
    usedSoFar = used;
    if (reading.resetAtMs > inForceFromMs && reading.resetAtMs <= inForceUntilMs) {
      fromMs = reading.resetAtMs;
      fromUsed = 0;
      usedSoFar = 0;
    }
  }
  if (fromMs > startMs && nowMs - fromMs < MIN_SINCE_RESET_MS) return null;
  return (usedOf(login.readings[last], nowMs) - fromUsed) / ((nowMs - fromMs) / HOUR_MS);
}

/** The pool's burn over the last `hours`, or null when any member's readings cannot vouch for it. */
export function burnOverWindow(
  history: QuotaHistory | null,
  members: readonly HistoryMember[],
  nowMs: number,
  hours: number
): number | null {
  if (!history || members.length === 0) return null;
  const startMs = nowMs - hours * HOUR_MS;
  let total = 0;
  for (const login of loginsOf(history, members)) {
    const burn = login ? loginBurn(login, startMs, nowMs) : null;
    if (burn === null) return null;
    total += burn;
  }
  return total;
}

export interface RatePoint {
  atMs: number;
  percentPerHour: number | null;
}

/** The measured burn every half hour from `startMs` up to now, and at now itself. */
export function drainSeries(
  history: QuotaHistory | null,
  members: readonly HistoryMember[],
  startMs: number,
  nowMs: number,
  hours: number
): RatePoint[] {
  const times: number[] = [];
  for (let atMs = startMs; atMs < nowMs; atMs += DRAIN_SAMPLE_MS) times.push(atMs);
  if (startMs <= nowMs) times.push(nowMs);
  return times.map((atMs) => ({
    atMs,
    percentPerHour: burnOverWindow(history, members, atMs, hours),
  }));
}

/** The latest sample at or before `atMs`. */
export function rateAt(series: readonly RatePoint[], atMs: number): number | null {
  const index = lastAtOrBefore(series, atMs, (point) => point.atMs);
  return index < 0 ? null : series[index].percentPerHour;
}
