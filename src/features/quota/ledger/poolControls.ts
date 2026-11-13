/**
 * The shared pool chart controls and the forecast they drive, React-free.
 */

import { DAY_MS } from '@/utils/time/durations';
import {
  burnOverWindow,
  drainSeries,
  recordedPool,
  type QuotaHistory,
  type RatePoint,
  type RecordedSegment,
} from '../history';
import { projectPool, type PoolCredential, type PoolProjection } from '../pool';
import { timelineSpan } from '../quotaTimelineModel';

export const POOL_VIEWS = ['remaining', 'drain'] as const;
export type PoolView = (typeof POOL_VIEWS)[number];

export const POOL_VIEW_LABEL_KEY: Record<PoolView, string> = {
  remaining: 'quota_ledger.view_remaining',
  drain: 'quota_ledger.view_drain',
};

export const BURN_WINDOW_HOURS = [1, 3, 6] as const;
export type BurnWindowHours = (typeof BURN_WINDOW_HOURS)[number];

/** Multiplier on the measured burn for each future usage scenario. */
export const FUTURE_USAGE = { same: 1, half: 0.5, double: 2 } as const;
export type FutureUsage = keyof typeof FUTURE_USAGE;

export const FUTURE_USAGE_LABEL_KEY: Record<FutureUsage, string> = {
  same: 'quota_ledger.future_same',
  half: 'quota_ledger.future_half',
  double: 'quota_ledger.future_double',
};

export const FUTURE_USAGES = Object.keys(FUTURE_USAGE_LABEL_KEY) as FutureUsage[];

export interface PoolControls {
  view: PoolView;
  burnWindowHours: BurnWindowHours;
  futureUsage: FutureUsage;
  /** Weeks from the current two-week span. */
  weekOffset: number;
}

export const DEFAULT_POOL_CONTROLS: PoolControls = {
  view: 'remaining',
  burnWindowHours: 3,
  futureUsage: 'same',
  weekOffset: 0,
};

/** The reader keeps this much history. */
export const HISTORY_KEPT_MS = 14 * DAY_MS;
export const MAX_WEEK_OFFSET = 2;

export interface WeekPager {
  earlier: boolean;
  later: boolean;
  today: boolean;
}

export const weekPager = (weekOffset: number, nowMs: number): WeekPager => ({
  earlier: timelineSpan('weekly', weekOffset - 1, nowMs).startMs >= nowMs - HISTORY_KEPT_MS,
  later: weekOffset < MAX_WEEK_OFFSET,
  today: weekOffset !== 0,
});

export interface PoolForecastInput {
  credentials: readonly PoolCredential[];
  recordedByReader: boolean;
  history: QuotaHistory | null;
  controls: Pick<PoolControls, 'burnWindowHours' | 'futureUsage'>;
  span: { startMs: number; endMs: number };
  nowMs: number;
}

export interface PoolForecast {
  /** Measured over the chosen window. Null when the readings cannot vouch for it. */
  burnPercentPerHour: number | null;
  /** The measured burn under the future usage scenario. */
  projectedPercentPerHour: number | null;
  projection: PoolProjection | null;
  recorded: RecordedSegment[];
  drain: RatePoint[];
}

export function forecastPool({
  credentials,
  recordedByReader,
  history,
  controls,
  span,
  nowMs,
}: PoolForecastInput): PoolForecast {
  if (!recordedByReader) {
    return {
      burnPercentPerHour: null,
      projectedPercentPerHour: null,
      projection: projectPool(credentials, { nowMs, endMs: span.endMs, burnPercentPerHour: 0 }),
      recorded: [],
      drain: [],
    };
  }
  const burn = burnOverWindow(history, credentials, nowMs, controls.burnWindowHours);
  const projected = burn === null ? null : burn * FUTURE_USAGE[controls.futureUsage];
  return {
    burnPercentPerHour: burn,
    projectedPercentPerHour: projected,
    projection:
      projected === null
        ? null
        : projectPool(credentials, {
            nowMs,
            endMs: span.endMs,
            burnPercentPerHour: projected,
          }),
    recorded: history ? recordedPool(history, credentials, span.startMs, nowMs) : [],
    drain: drainSeries(history, credentials, span.startMs, nowMs, controls.burnWindowHours),
  };
}
