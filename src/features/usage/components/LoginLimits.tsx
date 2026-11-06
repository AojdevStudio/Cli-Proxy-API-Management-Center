import { useTranslation } from 'react-i18next';
import { stripEmails } from '@/services/api/usage';
import { BRAND_COLORS } from '../colors';
import {
  agoMessage,
  compact,
  durationMessage,
  limitStatus,
  readStatus,
  renderMessage,
  type LimitsBrief,
  type LoginRow,
} from '../logic';
import styles from '../UsagePage.module.scss';
import { StatusWord, Swatch, ToneText } from './marks';

export function LoginLimits({
  logins,
  brief,
  loading,
  error,
  now,
}: {
  logins: LoginRow[];
  brief: LimitsBrief | null;
  loading: boolean;
  error: string;
  now: number;
}) {
  const { t } = useTranslation();

  return (
    <>
      {brief ? (
        <div className={styles.stat}>
          <h2 className={styles.statLabel}>{t('usage.limits.tightest')}</h2>
          <div className={styles.statValueLarge}>
            <Swatch brand={brief.tightest.brand} />
            <ToneText mark={brief.status}>{brief.tightest.pct}%</ToneText>
            <span className={styles.statSmall}>{brief.tightest.label}</span>
            <StatusWord mark={brief.status} />
          </div>
          <p className={styles.statDetail}>
            {brief.tightest.resetAtMs !== null
              ? t('usage.limits.tightest_reset', {
                  reset: renderMessage(t, durationMessage(brief.tightest.resetAtMs - now)),
                })
              : t('usage.limits.tightest_no_reset')}{' '}
            {brief.next
              ? t('usage.limits.tightest_next', { login: brief.next.label, pct: brief.next.pct })
              : null}
          </p>
        </div>
      ) : null}

      <h2 className={styles.sectionTitle} id="usage-logins">
        {t('usage.limits.title')}
      </h2>
      {/* Auth file names carry emails, and backend errors can quote them. */}
      {error ? (
        <p className={styles.readerNote}>
          {t('usage.limits.load_error', { error: stripEmails(error) })}
        </p>
      ) : logins.length === 0 ? (
        <p className={styles.readerNote}>
          {loading ? t('usage.limits.loading') : t('usage.limits.empty')}
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.limits.col_login')}</th>
                <th scope="col" className={styles.num}>
                  {t('usage.limits.col_weekly')}
                </th>
                <th scope="col" className={styles.meterCol}>
                  <span className={styles.srOnly}>{t('usage.limits.col_meter')}</span>
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.limits.col_resets')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.limits.col_five_hour')}
                </th>
                <th scope="col" className={`${styles.num} ${styles.hideSm}`}>
                  {t('usage.limits.col_today')}
                </th>
                <th scope="col" className={`${styles.num} ${styles.hideSm}`}>
                  {t('usage.limits.col_read')}
                </th>
              </tr>
            </thead>
            <tbody>
              {logins.map((row) => (
                <LoginTableRow key={row.key} row={row} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.note}>{t('usage.limits.source')}</p>
    </>
  );
}

function LoginTableRow({ row, now }: { row: LoginRow; now: number }) {
  const { t } = useTranslation();
  const { weekly, fiveHour } = row;
  const weeklyMark = weekly ? limitStatus(weekly.usedPercent) : null;
  const readText =
    row.read === 'unread'
      ? t('usage.limits.unread')
      : row.read === 'failed' || row.readAtMs === null
        ? ''
        : renderMessage(t, agoMessage(now - row.readAtMs));

  return (
    <tr>
      <th scope="row" className={styles.loginCell}>
        <Swatch brand={row.brand} />
        <span className={styles.loginLabel}>{row.label}</span>
        <StatusWord mark={readStatus(row.read)} />
      </th>
      <td className={styles.num}>
        {weekly ? (
          <>
            <ToneText mark={weeklyMark}>{Math.round(weekly.usedPercent)}%</ToneText>
            <StatusWord mark={weeklyMark} />
          </>
        ) : (
          t('usage.na')
        )}
      </td>
      <td className={styles.meterCol}>
        <div className={styles.meter} aria-hidden="true">
          {weekly ? (
            <i
              style={{
                width: `${Math.min(100, Math.max(0, weekly.usedPercent))}%`,
                background: BRAND_COLORS[row.brand],
              }}
            />
          ) : null}
        </div>
      </td>
      <td className={styles.num}>
        {weekly?.resetAtMs == null
          ? t('usage.na')
          : weekly.resetAtMs <= now
            ? t('usage.limits.reset_done')
            : renderMessage(t, durationMessage(weekly.resetAtMs - now))}
      </td>
      <td className={styles.num}>
        {!fiveHour
          ? t('usage.na')
          : fiveHour.resetAtMs !== null && fiveHour.resetAtMs <= now
            ? t('usage.limits.reset_done')
            : `${Math.round(fiveHour.usedPercent)}%`}
      </td>
      <td className={`${styles.num} ${styles.hideSm}`}>
        {row.tokensToday !== null ? compact(row.tokensToday) : t('usage.na')}
      </td>
      <td className={`${styles.num} ${styles.hideSm} ${styles.muted}`}>{readText}</td>
    </tr>
  );
}
