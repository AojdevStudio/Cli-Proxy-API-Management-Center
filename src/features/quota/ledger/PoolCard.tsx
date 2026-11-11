/**
 * One provider's pool: the big number, four stats, and the projection chart
 * over the same two-week span the timeline's weekly view uses.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getTypeLabel } from '@/features/authFiles/constants';
import { poolBurn, recordedPool, type QuotaHistory } from '../history';
import { timelineSpan } from '../quotaTimelineModel';
import { projectPool, type PoolNextReset, type PoolProvider, type PoolSummary } from '../pool';
import { formatMonthDay, formatWeekdayTime } from './ledgerModel';
import { PoolChart } from './PoolChart';
import styles from './QuotaLedger.module.scss';

interface PoolCardProps {
  provider: PoolProvider;
  pool: PoolSummary;
  nextReset: PoolNextReset;
  /** The provider's recorded history, or null while the reader has none to give. */
  history: QuotaHistory | null;
  now: number;
}

export function PoolCard({ provider, pool, nextReset, history, now }: PoolCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const providerName = getTypeLabel(t, provider);
  const span = useMemo(() => timelineSpan('weekly', 0, now), [now]);
  const recorded = useMemo(
    () => (history ? recordedPool(history, pool.credentials, span.startMs, now) : []),
    [history, pool.credentials, span.startMs, now]
  );
  const burnPercentPerHour = useMemo(
    () => poolBurn(history, pool.credentials, now),
    [history, pool.credentials, now]
  );
  const projection = useMemo(
    () =>
      projectPool(pool.credentials, {
        nowMs: now,
        endMs: span.endMs,
        burnPercentPerHour: burnPercentPerHour ?? 0,
      }),
    [pool.credentials, now, span.endMs, burnPercentPerHour]
  );

  const stats = [
    {
      label: t('quota_ledger.stat_pool_empty'),
      value:
        projection.poolEmptyMs !== null
          ? formatWeekdayTime(projection.poolEmptyMs, locale)
          : burnPercentPerHour === null
            ? t('quota_ledger.empty_unknown')
            : t('quota_ledger.not_by', { date: formatMonthDay(span.endMs - 1, locale) }),
    },
    {
      label: t('quota_ledger.stat_first_empty'),
      value:
        projection.firstEmpty !== null
          ? t('quota_ledger.first_empty_at', {
              name: projection.firstEmpty.name,
              when: formatWeekdayTime(projection.firstEmpty.atMs, locale),
            })
          : burnPercentPerHour === null
            ? t('quota_ledger.empty_unknown')
            : t('quota_ledger.none_before_reset'),
    },
    {
      label: t('quota_ledger.stat_next_reset'),
      value: t('quota_ledger.gain_at', {
        gain: Math.round(nextReset.gainPercent),
        when: formatWeekdayTime(nextReset.atMs, locale),
      }),
    },
    {
      label: t('quota_ledger.stat_burn'),
      value:
        burnPercentPerHour === null
          ? t('quota_ledger.no_history')
          : t('quota_ledger.burn_rate', { rate: burnPercentPerHour.toFixed(1) }),
    },
  ];

  return (
    <section
      className={styles.poolCard}
      aria-label={t('quota_ledger.pool_title', { provider: providerName })}
    >
      <div className={styles.poolTop}>
        <div className={styles.poolIdentity}>
          <div className={styles.poolName}>
            <span className={styles.dot} aria-hidden="true" />
            <h3>{providerName}</h3>
            <span className={styles.poolLogins}>
              {t('quota_ledger.logins', { count: pool.credentials.length })}
            </span>
          </div>
          <div className={styles.poolFigure}>
            <span className={styles.poolNumber}>{Math.round(pool.poolPercent)}%</span>
            <span className={styles.poolCap}>
              {t('quota_ledger.of_cap', { cap: pool.capPercent })}
            </span>
          </div>
        </div>
        <dl className={styles.poolStats}>
          {stats.map((stat) => (
            <div key={stat.label} className={styles.poolStat}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <PoolChart
        providerName={providerName}
        pool={pool}
        nextReset={nextReset}
        projection={projection}
        recorded={recorded}
        span={span}
        now={now}
      />
    </section>
  );
}
