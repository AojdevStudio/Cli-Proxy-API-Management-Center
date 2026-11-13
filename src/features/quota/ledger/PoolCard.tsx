/**
 * One provider's pool: the big number, four stats, and the projection chart
 * over the two-week span the shared controls page through.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getTypeLabel } from '@/features/authFiles/constants';
import type { QuotaHistory } from '../history';
import type { PoolModel, PoolNextReset, PoolProvider, PoolSummary } from '../pool';
import { formatMonthDay, formatWeekdayTime } from './ledgerModel';
import { FUTURE_USAGE_LABEL_KEY, forecastPool, type PoolControls } from './poolControls';
import { PoolChart } from './PoolChart';
import { Segmented } from './Segmented';
import styles from './QuotaLedger.module.scss';

export interface CardPool {
  model: PoolModel;
  recordedByReader: boolean;
  pool: PoolSummary;
  nextReset: PoolNextReset;
}

const MODEL_LABEL_KEY: Record<PoolModel, string> = {
  all: 'quota_ledger.model_all',
  fable: 'quota_ledger.model_fable',
};

interface PoolCardProps {
  provider: PoolProvider;
  /** The all-models pool first. Never empty. */
  pools: readonly CardPool[];
  history: QuotaHistory | null;
  controls: PoolControls;
  span: { startMs: number; endMs: number; days: number };
  now: number;
}

export function PoolCard({ provider, pools, history, controls, span, now }: PoolCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const providerName = getTypeLabel(t, provider);
  const [model, setModel] = useState<PoolModel>(pools[0].model);
  // A model's pool drops out when its windows stop loading, so fall back to the first.
  const selected = pools.find((candidate) => candidate.model === model) ?? pools[0];
  const { pool, nextReset, recordedByReader } = selected;
  const { burnWindowHours, futureUsage } = controls;
  const scenario = t(FUTURE_USAGE_LABEL_KEY[futureUsage]);

  const forecast = useMemo(
    () =>
      forecastPool({
        credentials: pool.credentials,
        recordedByReader,
        history,
        controls: { burnWindowHours, futureUsage },
        span,
        nowMs: now,
      }),
    [pool.credentials, recordedByReader, history, burnWindowHours, futureUsage, span, now]
  );
  const burn = forecast.burnPercentPerHour;
  const projection = burn === null ? null : forecast.projection;

  const stats = [
    {
      label: t('quota_ledger.stat_pool_empty'),
      value:
        projection === null
          ? t('quota_ledger.empty_unknown')
          : projection.poolEmptyMs === null
            ? t('quota_ledger.not_by', { date: formatMonthDay(span.endMs - 1, locale) })
            : formatWeekdayTime(projection.poolEmptyMs, locale),
    },
    {
      label: t('quota_ledger.stat_first_empty'),
      value:
        projection === null
          ? t('quota_ledger.empty_unknown')
          : projection.firstEmpty === null
            ? t('quota_ledger.none_before_reset')
            : t('quota_ledger.first_empty_at', {
                name: projection.firstEmpty.name,
                when: formatWeekdayTime(projection.firstEmpty.atMs, locale),
              }),
    },
    {
      label: t('quota_ledger.stat_next_reset'),
      value: t('quota_ledger.gain_at', {
        gain: Math.round(nextReset.gainPercent),
        when: formatWeekdayTime(nextReset.atMs, locale),
      }),
    },
    {
      label: t('quota_ledger.stat_burn', { hours: burnWindowHours }),
      value: !recordedByReader
        ? t('quota_ledger.burn_not_recorded')
        : burn === null
          ? t('quota_ledger.no_history')
          : t('quota_ledger.burn_rate', { rate: burn.toFixed(1) }),
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
            {pools.length > 1 && (
              <Segmented
                ariaLabel={t('quota_ledger.model_label')}
                options={pools.map((candidate) => ({
                  value: candidate.model,
                  label: t(MODEL_LABEL_KEY[candidate.model], {
                    percent: Math.round(candidate.pool.poolPercent),
                  }),
                }))}
                value={selected.model}
                onChange={setModel}
              />
            )}
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
        view={controls.view}
        pool={pool}
        nextReset={nextReset}
        forecast={forecast}
        recordedByReader={recordedByReader}
        burnWindowHours={burnWindowHours}
        scenario={scenario}
        span={span}
        now={now}
      />
    </section>
  );
}
