import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { brandFor } from '../colors';
import {
  clockCt,
  compact,
  dailyBars,
  formatMs,
  share,
  sparklinePoints,
  tokensOf,
  SESSION_SPARK_COUNT,
} from '../logic';
import type {
  BreakdownRow,
  ReaderSnapshot,
  SessionTurn,
  UsageOverview,
  UsageResult,
} from '../types';
import styles from '../UsagePage.module.scss';
import { Swatch } from './marks';
import { StackChart } from './StackChart';

function Fold({
  title,
  meta,
  children,
  onOpen,
}: {
  title: string;
  meta: string;
  children: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <details
      className={styles.fold}
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen?.();
      }}
    >
      <summary>
        <span className={styles.foldTitle}>{title}</span>
        <span className={styles.foldMeta}>{meta}</span>
      </summary>
      <div className={styles.foldBody}>{children}</div>
    </details>
  );
}

export function UsageFolds({
  snapshot,
  turns,
  time,
  locale,
  onSessionsOpen,
}: {
  snapshot: ReaderSnapshot;
  turns: ReadonlyMap<string, UsageResult<SessionTurn[]>>;
  time: string;
  locale: string;
  onSessionsOpen: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const { today, week, sessions } = snapshot;
  const tokens = tokensOf(today.totals);
  const shown = sessions.slice(0, SESSION_SPARK_COUNT);
  const p50 = today.totals.latencyMsP50;
  const na = t('usage.na');

  return (
    <div className={styles.folds}>
      <Fold
        title={t('usage.sections.sessions')}
        meta={t('usage.sections.sessions_meta', { n: sessions.length })}
        onOpen={() => onSessionsOpen(shown.map((s) => s.id))}
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.table.session')}</th>
                <th scope="col" className={styles.hideSm}>
                  {t('usage.table.model')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.table.tokens')}
                </th>
                <th scope="col" className={`${styles.num} ${styles.hideSm}`}>
                  {t('usage.table.turns')}
                </th>
                <th scope="col" className={styles.hideSm}>
                  {t('usage.table.active')}
                </th>
                <th scope="col">{t('usage.table.context')}</th>
                <th scope="col" className={styles.num}>
                  {t('usage.table.now')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((session) => {
                const result = turns.get(session.id);
                return (
                  <tr key={session.id}>
                    <th scope="row">
                      {session.client} {session.id.slice(0, 8)}
                    </th>
                    <td className={styles.hideSm}>{session.models.join(', ')}</td>
                    <td className={styles.num}>{compact(tokensOf(session.totals))}</td>
                    <td className={`${styles.num} ${styles.hideSm}`}>
                      {session.turns.toLocaleString(locale)}
                    </td>
                    <td className={styles.hideSm}>
                      {t('usage.table.time_range', {
                        from: clockCt(session.firstAt, locale),
                        to: clockCt(session.lastAt, locale),
                      })}
                    </td>
                    <td>
                      {result?.status === 'ready' ? (
                        <svg
                          className={styles.spark}
                          viewBox="0 0 110 20"
                          role="img"
                          aria-label={t('usage.table.context_label', {
                            peak: compact(session.peakPrompt),
                          })}
                        >
                          <polyline points={sparklinePoints(result.data, 110, 20)} />
                        </svg>
                      ) : (
                        <span className={styles.muted}>
                          {result ? na : t('usage.table.context_loading')}
                        </span>
                      )}
                    </td>
                    <td className={styles.num}>{compact(session.lastPrompt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={styles.note}>{t('usage.table.context_note')}</p>
      </Fold>

      <Fold
        title={t('usage.sections.days')}
        meta={t('usage.sections.days_meta', { tokens: compact(tokensOf(week.totals)) })}
      >
        <StackChart
          variant="days"
          bars={dailyBars(week, locale, t('usage.today_label'))}
          groups={week.series.groups}
          label={t('usage.chart.days_label')}
        />
        <p className={styles.note}>{t('usage.days_note', { time })}</p>
      </Fold>

      <Fold
        title={t('usage.sections.models')}
        meta={t('usage.sections.count_meta', { n: today.breakdown.model.length })}
      >
        <BreakdownTable
          rows={today.breakdown.model}
          total={tokens}
          heading={t('usage.table.model')}
          locale={locale}
        />
      </Fold>

      <Fold
        title={t('usage.sections.clients')}
        meta={t('usage.sections.count_meta', { n: today.breakdown.client.length })}
      >
        <BreakdownTable
          rows={today.breakdown.client}
          total={tokens}
          heading={t('usage.table.client')}
          locale={locale}
        />
      </Fold>

      <Fold
        title={t('usage.sections.speed')}
        meta={p50 !== null ? t('usage.sections.speed_meta', { ms: formatMs(p50) }) : na}
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.table.model')}</th>
                <th scope="col" className={styles.num}>
                  {t('usage.table.median')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.table.requests')}
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                { key: '', label: t('usage.speed.all'), totals: today.totals },
                ...today.breakdown.model,
              ].map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td className={styles.num}>
                    {row.totals.latencyMsP50 !== null ? formatMs(row.totals.latencyMsP50) : na}
                  </td>
                  <td className={styles.num}>{row.totals.requests.toLocaleString(locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.note}>{t('usage.speed.note')}</p>
      </Fold>

      <Fold
        title={t('usage.sections.mix')}
        meta={t('usage.sections.mix_meta', {
          pct: Math.round(share(today.totals.cacheRead, tokens)),
        })}
      >
        <TokenMix today={today} />
      </Fold>
    </div>
  );
}

function BreakdownTable({
  rows,
  total,
  heading,
  locale,
}: {
  rows: BreakdownRow[];
  total: number;
  heading: string;
  locale: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{heading}</th>
            <th scope="col" className={styles.num}>
              {t('usage.table.tokens')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.table.share')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.table.requests')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.table.failed')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={styles.loginCell}>
                <Swatch brand={brandFor(row.key)} />
                <span className={styles.loginLabel}>{row.label}</span>
              </th>
              <td className={styles.num}>{compact(tokensOf(row.totals))}</td>
              <td className={styles.num}>{share(tokensOf(row.totals), total).toFixed(1)}%</td>
              <td className={styles.num}>{row.totals.requests.toLocaleString(locale)}</td>
              <td className={styles.num}>{row.totals.failed.toLocaleString(locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TokenMix({ today }: { today: UsageOverview }) {
  const { t } = useTranslation();
  const { totals } = today;
  const tokens = tokensOf(totals);
  const { reasoning } = totals;
  const reasoningKnown = reasoning.rowsReporting > 0;
  const rows: { name: string; value: number | null; note?: string }[] = [
    { name: t('usage.mix.cache_read'), value: totals.cacheRead },
    { name: t('usage.mix.fresh'), value: totals.freshInput },
    { name: t('usage.mix.cache_write'), value: totals.cacheWrite },
    { name: t('usage.mix.output'), value: totals.output },
    {
      name: t('usage.mix.reasoning'),
      value: reasoningKnown ? reasoning.sum : null,
      note:
        reasoningKnown && reasoning.rowsReporting < totals.requests
          ? t('usage.partial', { pct: Math.round(share(reasoning.rowsReporting, totals.requests)) })
          : undefined,
    },
  ];
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('usage.table.kind')}</th>
            <th scope="col" className={styles.num}>
              {t('usage.table.tokens')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.table.share')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ name, value, note }) => (
            <tr key={name}>
              <th scope="row">
                {name}
                {note ? <span className={styles.muted}> {note}</span> : null}
              </th>
              <td className={styles.num}>{value !== null ? compact(value) : t('usage.na')}</td>
              <td className={styles.num}>
                {value !== null ? `${share(value, tokens).toFixed(1)}%` : t('usage.na')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
