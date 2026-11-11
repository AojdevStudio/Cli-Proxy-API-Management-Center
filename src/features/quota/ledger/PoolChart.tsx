/**
 * Pool level over the timeline's two-week span: recorded steps where every
 * login has a reading, a dashed projection from now, and a "+N%" label at each
 * reset step. A span with no recorded total stays blank and reads as unknown.
 *
 * Lines are drawn in a stretched SVG with non-scaling strokes. Text, the dot,
 * and the tooltip are HTML placed by percent, so nothing distorts at any width.
 */

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { HOUR_MS } from '@/utils/time/durations';
import { recordedLevelAt, type RecordedSegment } from '../history';
import { timelineCells } from '../quotaTimelineModel';
import {
  poolLevelAt,
  type PoolNextReset,
  type PoolPoint,
  type PoolProjection,
  type PoolSummary,
} from '../pool';
import { formatWeekdayTime } from './ledgerModel';
import styles from './QuotaLedger.module.scss';

const VIEW_W = 1000;
const VIEW_H = 200;
const KEY_STEP_MS = 6 * HOUR_MS;
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface PoolChartProps {
  providerName: string;
  pool: PoolSummary;
  nextReset: PoolNextReset;
  projection: PoolProjection;
  recorded: readonly RecordedSegment[];
  span: { startMs: number; endMs: number; days: number };
  now: number;
}

export function PoolChart({
  providerName,
  pool,
  nextReset,
  projection,
  recorded,
  span,
  now,
}: PoolChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const liveId = useId();
  const [cursorMs, setCursorMs] = useState<number | null>(null);

  const spanMs = span.endMs - span.startMs;
  const cap = pool.capPercent;
  const xOf = (ms: number) => ((ms - span.startMs) / spanMs) * VIEW_W;
  const yOf = (percent: number) => VIEW_H - (percent / cap) * VIEW_H;
  const leftPct = (ms: number) => (xOf(ms) / VIEW_W) * 100;
  const topPct = (percent: number) => (yOf(percent) / VIEW_H) * 100;
  const pathOf = (points: readonly PoolPoint[]) =>
    points
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${xOf(point.atMs).toFixed(2)},${yOf(point.poolPercent).toFixed(2)}`
      )
      .join(' ');
  const areaOf = (points: readonly PoolPoint[]) =>
    `${pathOf(points)} L${xOf(points[points.length - 1].atMs).toFixed(2)},${VIEW_H} L${xOf(points[0].atMs).toFixed(2)},${VIEW_H} Z`;

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

  const labelledSteps = projection.steps.filter((step) => Math.round(step.gainPercent) > 0);
  const earliestMs = recorded.length > 0 ? recorded[0][0].atMs : now;
  const clampCursor = (ms: number) => Math.min(span.endMs, Math.max(earliestMs, ms));

  const detail = t('quota_ledger.tooltip_detail', {
    provider: providerName,
    pool: Math.round(pool.poolPercent),
    cap,
    gain: Math.round(nextReset.gainPercent),
    when: formatWeekdayTime(nextReset.atMs, locale),
  });
  const describe = (atMs: number) => {
    const when = formatWeekdayTime(atMs, locale);
    if (atMs >= now) {
      const percent = poolLevelAt(projection.points, atMs);
      return {
        atMs,
        percent,
        title: t('quota_ledger.tooltip_projected', { when, percent: Math.round(percent) }),
      };
    }
    const percent = recordedLevelAt(recorded, atMs);
    return {
      atMs,
      percent,
      title:
        percent === null
          ? t('quota_ledger.tooltip_unknown', { when })
          : t('quota_ledger.tooltip_recorded', { when, percent: Math.round(percent) }),
    };
  };
  // The minute clock moves the range under a cursor that stays put, so clamp on every render.
  const cursorAtMs = cursorMs === null ? null : clampCursor(cursorMs);
  const cursor = cursorAtMs === null ? null : describe(cursorAtMs);

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
    const from = cursorAtMs ?? now;
    const step = event.shiftKey ? 24 * HOUR_MS : KEY_STEP_MS;
    const targets: Partial<Record<string, number>> = {
      ArrowRight: from + step,
      ArrowLeft: from - step,
      Home: earliestMs,
      End: span.endMs,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setCursorMs(clampCursor(next));
  };

  return (
    <figure className={styles.chart}>
      <div className={styles.chartBody}>
        <div className={styles.yAxis} aria-hidden="true">
          {[cap, cap / 2, 0].map((value) => (
            <span key={value} style={{ top: `${topPct(value)}%` }}>
              {Math.round(value)}%
            </span>
          ))}
        </div>
        <div
          className={styles.plot}
          tabIndex={0}
          role="group"
          aria-label={t('quota_ledger.chart_label', { provider: providerName })}
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
            {[0, VIEW_H / 2, VIEW_H].map((y) => (
              <line key={y} className={styles.grid} x1={0} x2={VIEW_W} y1={y} y2={y} />
            ))}
            {recorded.map((segment) => (
              <g key={segment[0].atMs}>
                <path className={styles.recordedArea} d={areaOf(segment)} />
                <path className={styles.recordedLine} d={pathOf(segment)} />
              </g>
            ))}
            <path className={styles.projectedArea} d={areaOf(projection.points)} />
            <path className={styles.projectedLine} d={pathOf(projection.points)} />
            <line className={styles.nowLine} x1={xOf(now)} x2={xOf(now)} y1={0} y2={VIEW_H} />
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
          <span className={styles.nowLabel} style={{ left: `${leftPct(now)}%` }} aria-hidden="true">
            {t('quota_ledger.now')}
          </span>
          {labelledSteps.map((step) => (
            <span
              key={`${step.atMs}:${step.name}`}
              className={styles.stepLabel}
              style={{ left: `${leftPct(step.atMs)}%`, top: `${topPct(step.poolPercent)}%` }}
              aria-hidden="true"
            >
              +{Math.round(step.gainPercent)}%
            </span>
          ))}
          {cursor && (
            <>
              {cursor.percent !== null && (
                <span
                  className={styles.cursorDot}
                  style={{ left: `${leftPct(cursor.atMs)}%`, top: `${topPct(cursor.percent)}%` }}
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
      <figcaption className={styles.legend}>
        <span className={styles.legendTitle}>{t('quota_ledger.legend_pool')}</span>
        {recorded.length > 0 ? (
          <span className={styles.legendItem}>
            <span className={styles.swatchRecorded} aria-hidden="true" />
            {t('quota_ledger.legend_recorded')}
          </span>
        ) : (
          <span className={styles.legendMuted}>{t('quota_ledger.legend_no_history')}</span>
        )}
        <span className={styles.legendItem}>
          <span className={styles.swatchProjected} aria-hidden="true" />
          {t('quota_ledger.legend_projected')}
        </span>
      </figcaption>
    </figure>
  );
}
