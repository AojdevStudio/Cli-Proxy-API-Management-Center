import { useTranslation } from 'react-i18next';
import { compact, hourlyBars, type UsageBrief } from '../logic';
import type { SessionSummary, UsageOverview } from '../types';
import styles from '../UsagePage.module.scss';
import { StatusWord, ToneText } from './marks';
import { StackChart } from './StackChart';

export function TodayPanel({
  today,
  biggest,
  brief,
  time,
  locale,
}: {
  today: UsageOverview;
  biggest: SessionSummary | undefined;
  brief: UsageBrief;
  time: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const { tokens, failed } = brief;

  return (
    <>
      <div className={styles.stat}>
        <h2 className={styles.statLabel}>{t('usage.today.tokens')}</h2>
        <div className={styles.statValue}>
          {compact(tokens.total)}
          {tokens.deltaPct !== null ? (
            <span className={styles.statSmall}>
              {tokens.deltaPct >= 0 ? '+' : ''}
              {tokens.deltaPct}%
            </span>
          ) : null}
        </div>
        <p className={styles.statDetail}>
          {tokens.deltaPct !== null
            ? t('usage.today.tokens_baseline', { time })
            : t('usage.sentence.tokens_no_baseline')}{' '}
          {tokens.cachePct !== null
            ? t('usage.today.tokens_cache', { pct: tokens.cachePct })
            : null}
        </p>
      </div>

      <div className={styles.stat}>
        <h2 className={styles.statLabel}>{t('usage.today.failed')}</h2>
        <div className={styles.statValue}>
          <ToneText mark={failed.status}>{failed.count.toLocaleString(locale)}</ToneText>
          <span className={styles.statSmall}>{failed.ratePct.toFixed(1)}%</span>
          <StatusWord mark={failed.status} />
        </div>
        <p className={styles.statDetail}>
          {t('usage.today.failed_of', { requests: failed.requests.toLocaleString(locale) })}{' '}
          {failed.weekRatePct !== null
            ? t('usage.sentence.failed_week', { pct: failed.weekRatePct.toFixed(1) })
            : null}
        </p>
      </div>

      <div className={styles.stat}>
        <h2 className={styles.statLabel}>{t('usage.today.biggest')}</h2>
        {biggest ? (
          <>
            <div className={styles.statValue}>{compact(biggest.totals.tokens)}</div>
            <p className={styles.statDetail}>
              {t('usage.today.biggest_detail', {
                client: biggest.client,
                id: biggest.sessionId.slice(0, 8),
                model: biggest.models.join(', ') || t('usage.na'),
                context: compact(biggest.lastPrompt),
              })}
            </p>
          </>
        ) : (
          <p className={styles.statDetail}>{t('usage.today.no_sessions')}</p>
        )}
      </div>

      <h2 className={styles.statLabel}>{t('usage.today.hourly')}</h2>
      <StackChart
        variant="hours"
        bars={hourlyBars(today, locale)}
        groups={today.series.groups}
        label={t('usage.chart.hours_label')}
        note={t('usage.chart.now_note')}
      />
    </>
  );
}
