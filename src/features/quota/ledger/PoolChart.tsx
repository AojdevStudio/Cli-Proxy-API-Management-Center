/**
 * Lines are drawn in a stretched SVG with non-scaling strokes. Text, dots,
 * rings, and the tooltip are HTML placed by percent, so nothing distorts at
 * any width.
 */

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { HOUR_MS } from '@/utils/time/durations';
import { rateAt, recordedLevelAt, type RatePoint } from '../history';
import { timelineCells } from '../quotaTimelineModel';
import { emptyWithin, poolLevelAt, type PoolNextReset, type PoolSummary } from '../pool';
import { formatWeekdayTime } from './ledgerModel';
import type { BurnWindowHours, PoolForecast, PoolView } from './poolControls';
import styles from './QuotaLedger.module.scss';

const VIEW_W = 1000;
const VIEW_H = 200;
const KEY_STEP_MS = 6 * HOUR_MS;
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface ChartPoint {
  atMs: number;
  value: number;
}

/** A round axis top at or above `value`: 1, 2, 4, or 5 times a power of ten. */
function rateAxisMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 4, 5].map((step) => step * power).find((top) => top >= value) ?? 10 * power;
}

const formatRate = (rate: number) => String(Number(rate.toFixed(2)));

/** Runs of consecutive measured samples. A null sample breaks the line. */
function rateRuns(series: readonly RatePoint[]): ChartPoint[][] {
  const runs: ChartPoint[][] = [];
  let open: ChartPoint[] | null = null;
  for (const { atMs, percentPerHour } of series) {
    if (percentPerHour === null) {
      open = null;
    } else if (open === null) {
      open = [{ atMs, value: percentPerHour }];
      runs.push(open);
    } else {
      open.push({ atMs, value: percentPerHour });
    }
  }
  return runs;
}

interface PoolChartProps {
  providerName: string;
  view: PoolView;
  pool: PoolSummary;
  nextReset: PoolNextReset;
  forecast: PoolForecast;
  recordedByReader: boolean;
  burnWindowHours: BurnWindowHours;
  /** The future usage scenario, already translated. */
  scenario: string;
  span: { startMs: number; endMs: number; days: number };
  now: number;
}

export function PoolChart({
  providerName,
  view,
  pool,
  nextReset,
  forecast,
  recordedByReader,
  burnWindowHours,
  scenario,
  span,
  now,
}: PoolChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const liveId = useId();
  const clipId = `pool-clip-${useId().replace(/[^\w-]/g, '')}`;
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const { projection, recorded, drain, projectedPercentPerHour: projectedRate } = forecast;

  const drainRuns = useMemo(() => rateRuns(drain), [drain]);
  const remaining = view === 'remaining';
  const max = remaining
    ? pool.capPercent
    : rateAxisMax(Math.max(projectedRate ?? 0, ...drain.map((point) => point.percentPerHour ?? 0)));

  const spanMs = span.endMs - span.startMs;
  const xOf = (ms: number) => ((ms - span.startMs) / spanMs) * VIEW_W;
  const yOf = (value: number) => VIEW_H - (value / max) * VIEW_H;
  const leftPct = (ms: number) => (xOf(ms) / VIEW_W) * 100;
  const topPct = (value: number) => (yOf(value) / VIEW_H) * 100;
  const pathOf = (points: readonly ChartPoint[]) =>
    points
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${xOf(point.atMs).toFixed(2)},${yOf(point.value).toFixed(2)}`
      )
      .join(' ');
  const areaOf = (points: readonly ChartPoint[]) =>
    `${pathOf(points)} L${xOf(points[points.length - 1].atMs).toFixed(2)},${VIEW_H} L${xOf(points[0].atMs).toFixed(2)},${VIEW_H} Z`;
  const poolPoints = (points: readonly { atMs: number; poolPercent: number }[]) =>
    points.map(({ atMs, poolPercent }) => ({ atMs, value: poolPercent }));

  const days = useMemo(
    () =>
      timelineCells('weekly', span).map(({ at, durationMs }) => {
        const date = new Date(at);
        return {
          at,
          centerMs: at + durationMs / 2,
          label: `${t(`quota_management.weekday_${WEEKDAY_KEYS[date.getDay()]}`)} ${date.getDate()}`,
        };
      }),
    [span, t]
  );

  const inSpan = (ms: number) => ms >= span.startMs && ms <= span.endMs;
  const nowInSpan = inSpan(now);
  const aheadFromMs = Math.max(now, span.startMs);
  const labelledSteps = projection
    ? projection.steps.filter((step) => Math.round(step.gainPercent) > 0 && inSpan(step.atMs))
    : [];
  const emptyMs = projection ? emptyWithin(projection.points, span.startMs, span.endMs) : null;
  const clampCursor = (ms: number) => Math.min(span.endMs, Math.max(span.startMs, ms));

  const detail = t('quota_ledger.tooltip_detail', {
    provider: providerName,
    pool: Math.round(pool.poolPercent),
    cap: pool.capPercent,
    gain: Math.round(nextReset.gainPercent),
    when: formatWeekdayTime(nextReset.atMs, locale),
  });
  const describeRemaining = (atMs: number, when: string) => {
    if (atMs === now) {
      return {
        value: pool.poolPercent,
        title: t('quota_ledger.tooltip_current', { when, percent: Math.round(pool.poolPercent) }),
      };
    }
    if (atMs > now) {
      const value = projection ? poolLevelAt(projection.points, atMs) : null;
      return {
        value,
        title:
          value === null
            ? t('quota_ledger.tooltip_no_projection', { when })
            : t('quota_ledger.tooltip_projected', { when, percent: Math.round(value) }),
      };
    }
    const value = recordedLevelAt(recorded, atMs);
    return {
      value,
      title:
        value === null
          ? t('quota_ledger.tooltip_unknown', { when })
          : t('quota_ledger.tooltip_recorded', { when, percent: Math.round(value) }),
    };
  };
  const describeDrain = (atMs: number, when: string) => {
    if (atMs > now) {
      return {
        value: projectedRate,
        title:
          projectedRate === null
            ? t('quota_ledger.tooltip_no_projection', { when })
            : t('quota_ledger.tooltip_drain_projected', {
                when,
                rate: projectedRate.toFixed(1),
                scenario,
              }),
      };
    }
    const value = rateAt(drain, atMs);
    return {
      value,
      title:
        value === null
          ? t('quota_ledger.tooltip_drain_unknown', { when })
          : t('quota_ledger.tooltip_drain_measured', { when, rate: value.toFixed(1) }),
    };
  };
  // The minute clock moves the range under a cursor that stays put, so clamp on every render.
  const cursorAtMs = cursorMs === null ? null : clampCursor(cursorMs);
  const cursor =
    cursorAtMs === null
      ? null
      : {
          atMs: cursorAtMs,
          ...(remaining ? describeRemaining : describeDrain)(
            cursorAtMs,
            formatWeekdayTime(cursorAtMs, locale)
          ),
        };

  const handlePointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setCursorMs(clampCursor(span.startMs + fraction * spanMs));
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setCursorMs(null);
      return;
    }
    const from = cursorAtMs ?? clampCursor(now);
    const step = event.shiftKey ? 24 * HOUR_MS : KEY_STEP_MS;
    const targets: Partial<Record<string, number>> = {
      ArrowRight: from + step,
      ArrowLeft: from - step,
      Home: span.startMs,
      End: span.endMs,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setCursorMs(clampCursor(next));
  };

  const tickLabel = (value: number) =>
    remaining ? `${Math.round(value)}%` : t('quota_ledger.burn_rate', { rate: formatRate(value) });
  const unrecorded = (
    <span className={styles.legendMuted}>{t('quota_ledger.legend_fable_unrecorded')}</span>
  );

  return (
    <figure className={styles.chart}>
      <div className={styles.chartBody}>
        <div className={styles.yAxis} aria-hidden="true">
          {[max, max / 2, 0].map((value) => (
            <span key={value} style={{ top: `${topPct(value)}%` }}>
              {tickLabel(value)}
            </span>
          ))}
        </div>
        <div
          className={styles.plot}
          tabIndex={0}
          role="group"
          aria-label={t(remaining ? 'quota_ledger.chart_label' : 'quota_ledger.chart_label_drain', {
            provider: providerName,
          })}
          aria-describedby={liveId}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setCursorMs(null)}
          onFocus={() => setCursorMs((value) => value ?? clampCursor(now))}
          onBlur={() => setCursorMs(null)}
          onKeyDown={handleKey}
        >
          <svg
            className={styles.svg}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={0} y={-VIEW_H} width={VIEW_W} height={3 * VIEW_H} />
              </clipPath>
            </defs>
            {[0, VIEW_H / 2, VIEW_H].map((y) => (
              <line key={y} className={styles.grid} x1={0} x2={VIEW_W} y1={y} y2={y} />
            ))}
            <g clipPath={`url(#${clipId})`}>
              {remaining ? (
                <>
                  {recorded.map((segment) => (
                    <g key={segment.points[0].atMs}>
                      <path
                        className={styles.recordedArea}
                        d={areaOf(poolPoints(segment.points))}
                      />
                      <path
                        className={styles.recordedLine}
                        d={pathOf(poolPoints(segment.points))}
                      />
                    </g>
                  ))}
                  {projection && (
                    <>
                      <path
                        className={styles.projectedArea}
                        d={areaOf(poolPoints(projection.points))}
                      />
                      <path
                        className={styles.projectedLine}
                        d={pathOf(poolPoints(projection.points))}
                      />
                    </>
                  )}
                </>
              ) : (
                <>
                  {drainRuns.map((run) => (
                    <g key={run[0].atMs}>
                      <path className={styles.recordedArea} d={areaOf(run)} />
                      <path className={styles.recordedLine} d={pathOf(run)} />
                    </g>
                  ))}
                  {projectedRate !== null && aheadFromMs < span.endMs && (
                    <path
                      className={styles.projectedLine}
                      d={pathOf([
                        { atMs: aheadFromMs, value: projectedRate },
                        { atMs: span.endMs, value: projectedRate },
                      ])}
                    />
                  )}
                </>
              )}
            </g>
            {nowInSpan && (
              <line className={styles.nowLine} x1={xOf(now)} x2={xOf(now)} y1={0} y2={VIEW_H} />
            )}
            {cursor && (
              <line
                className={styles.cursorLine}
                x1={xOf(cursor.atMs)}
                x2={xOf(cursor.atMs)}
                y1={0}
                y2={VIEW_H}
              />
            )}
          </svg>
          {nowInSpan && (
            <span
              className={styles.nowLabel}
              style={{ left: `${leftPct(now)}%` }}
              aria-hidden="true"
            >
              {t('quota_ledger.now')}
            </span>
          )}
          {remaining &&
            labelledSteps.map((step) => (
              <span
                key={`${step.atMs}:${step.name}`}
                className={styles.stepLabel}
                style={{ left: `${leftPct(step.atMs)}%`, top: `${topPct(step.poolPercent)}%` }}
                aria-hidden="true"
              >
                +{Math.round(step.gainPercent)}%
              </span>
            ))}
          {remaining && emptyMs !== null && (
            <>
              <span
                className={styles.emptyRing}
                style={{ left: `${leftPct(emptyMs)}%`, top: '100%' }}
                aria-hidden="true"
              />
              <span
                className={`${styles.emptyLabel} ${leftPct(emptyMs) > 50 ? styles.emptyLabelStart : ''}`}
                style={{ left: `${leftPct(emptyMs)}%` }}
                aria-hidden="true"
              >
                {t('quota_ledger.empty_at', { when: formatWeekdayTime(emptyMs, locale) })}
              </span>
            </>
          )}
          {!remaining && projectedRate !== null && aheadFromMs < span.endMs && (
            <span
              className={styles.aheadLabel}
              style={{ left: `${leftPct(aheadFromMs)}%`, top: `${topPct(projectedRate)}%` }}
              aria-hidden="true"
            >
              {t('quota_ledger.drain_ahead_label', {
                scenario,
                rate: projectedRate.toFixed(1),
              })}
            </span>
          )}
          {!remaining &&
            drainRuns
              .filter((run) => run.length === 1)
              .map(([sample]) => (
                <span
                  key={sample.atMs}
                  className={styles.sampleDot}
                  style={{ left: `${leftPct(sample.atMs)}%`, top: `${topPct(sample.value)}%` }}
                  aria-hidden="true"
                />
              ))}
          {cursor && (
            <>
              {cursor.value !== null && (
                <span
                  className={styles.cursorDot}
                  style={{ left: `${leftPct(cursor.atMs)}%`, top: `${topPct(cursor.value)}%` }}
                  aria-hidden="true"
                />
              )}
              <div
                className={styles.tooltip}
                style={
                  leftPct(cursor.atMs) > 60
                    ? { right: `${100 - leftPct(cursor.atMs)}%` }
                    : { left: `${leftPct(cursor.atMs)}%` }
                }
                aria-hidden="true"
              >
                <strong>{cursor.title}</strong>
                <span>{detail}</span>
              </div>
            </>
          )}
          <span id={liveId} className={styles.srOnly} aria-live="polite">
            {cursor ? `${cursor.title}. ${detail}` : ''}
          </span>
        </div>
      </div>
      <div className={styles.days} aria-hidden="true">
        {days.map((day) => (
          <span key={day.at} style={{ left: `${leftPct(day.centerMs)}%` }}>
            {day.label}
          </span>
        ))}
      </div>
      {remaining ? (
        <figcaption className={styles.legend}>
          <span className={styles.legendTitle}>{t('quota_ledger.legend_pool')}</span>
          {recorded.length > 0 ? (
            <span className={styles.legendItem}>
              <span className={styles.swatchRecorded} aria-hidden="true" />
              {t('quota_ledger.legend_recorded')}
            </span>
          ) : recordedByReader ? (
            <span className={styles.legendMuted}>{t('quota_ledger.legend_no_history')}</span>
          ) : (
            unrecorded
          )}
          {projection ? (
            <span className={styles.legendItem}>
              <span className={styles.swatchProjected} aria-hidden="true" />
              {recordedByReader
                ? t('quota_ledger.legend_projected', { scenario })
                : t('quota_ledger.legend_resets_only')}
            </span>
          ) : (
            <span className={styles.legendMuted}>{t('quota_ledger.legend_no_projection')}</span>
          )}
          {emptyMs !== null && (
            <span className={styles.legendItem}>
              <span className={styles.swatchEmpty} aria-hidden="true" />
              {t('quota_ledger.legend_empty')}
            </span>
          )}
        </figcaption>
      ) : (
        <figcaption className={styles.legend}>
          <span className={styles.legendTitle}>{t('quota_ledger.legend_drain')}</span>
          {!recordedByReader ? (
            unrecorded
          ) : (
            <>
              {drainRuns.length > 0 ? (
                <span className={styles.legendItem}>
                  <span className={styles.swatchRecorded} aria-hidden="true" />
                  {t('quota_ledger.legend_measured', { hours: burnWindowHours })}
                </span>
              ) : (
                <span className={styles.legendMuted}>{t('quota_ledger.legend_no_rate')}</span>
              )}
              {projectedRate !== null ? (
                <span className={styles.legendItem}>
                  <span className={styles.swatchProjected} aria-hidden="true" />
                  {t('quota_ledger.legend_ahead', { scenario })}
                </span>
              ) : (
                <span className={styles.legendMuted}>{t('quota_ledger.legend_no_projection')}</span>
              )}
            </>
          )}
        </figcaption>
      )}
    </figure>
  );
}
