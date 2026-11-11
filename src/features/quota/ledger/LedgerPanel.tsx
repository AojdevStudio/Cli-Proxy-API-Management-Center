/**
 * One provider's ledger: pool header, then one row per login with its two
 * limits, reset credits, and the existing reset and refresh flows.
 */

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconChevronDown,
  IconChevronUp,
  IconRefreshCw,
  IconSidebarQuickStart,
} from '@/components/ui/icons';
import { getTypeLabel } from '@/features/authFiles/constants';
import { formatRelativeInstant, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { MINUTE_MS } from '@/utils/time/durations';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { POOL_WINDOW_ID, type PoolProvider, type PoolSummary } from '../pool';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { CLAUDE_CONFIG } from '../providers/claude/data';
import { CODEX_CONFIG } from '../providers/codex/data';
import { codexPlanLabel } from '../providers/codex/planLabel';
import {
  LEDGER_COLUMNS,
  formatSpan,
  formatWeekdayTime,
  ledgerLimit,
  type LedgerEntry,
  type LedgerLimit,
} from './ledgerModel';
import styles from './QuotaLedger.module.scss';

const I18N_PREFIX: Record<PoolProvider, string> = {
  claude: CLAUDE_CONFIG.i18nPrefix,
  codex: CODEX_CONFIG.i18nPrefix,
};

export interface LedgerActions {
  canUseActions: boolean;
  resettingQuotaName: string | null;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
}

interface LedgerPanelProps extends LedgerActions {
  provider: PoolProvider;
  ledgers: readonly LedgerEntry[];
  pool: PoolSummary;
  now: number;
}

export function LedgerPanel({ provider, ledgers, pool, now, ...actions }: LedgerPanelProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(true);
  const tableId = useId();
  const [first, second] = LEDGER_COLUMNS[provider];
  const providerName = getTypeLabel(t, provider);

  return (
    <section className={styles.panel} aria-label={providerName}>
      <header className={styles.panelHead}>
        <span className={styles.dot} aria-hidden="true" />
        <h2 className={styles.panelName}>{providerName}</h2>
        <span className={styles.count}>
          <span aria-hidden="true">{ledgers.length}</span>
          <span className={styles.srOnly}>
            {t('quota_management.meta_credentials', { count: ledgers.length })}
          </span>
        </span>
        {pool.capPercent > 0 ? (
          <span className={styles.headStat}>
            <strong className={styles.headPool}>{Math.round(pool.poolPercent)}%</strong>{' '}
            {t('quota_ledger.pool_of', { cap: pool.capPercent })}
          </span>
        ) : (
          <span className={styles.headStat}>{t('quota_ledger.pool_not_loaded')}</span>
        )}
        {pool.nextReset && (
          <span className={styles.headStat}>
            {t('quota_ledger.next_reset', {
              gain: Math.round(pool.nextReset.gainPercent),
              when: formatWeekdayTime(pool.nextReset.atMs, i18n.resolvedLanguage),
            })}
          </span>
        )}
        {pool.skippedCount > 0 && (
          <span className={styles.headSkipped}>
            {t('quota_ledger.not_loaded_count', { count: pool.skippedCount })}
          </span>
        )}
        <button
          type="button"
          className={styles.collapse}
          aria-expanded={open}
          aria-controls={tableId}
          onClick={() => setOpen((value) => !value)}
        >
          {t(open ? 'quota_ledger.collapse' : 'quota_ledger.expand')}
          {open ? (
            <IconChevronUp size={14} aria-hidden="true" />
          ) : (
            <IconChevronDown size={14} aria-hidden="true" />
          )}
        </button>
      </header>

      <div id={tableId} className={styles.tableWrap} hidden={!open}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('quota_ledger.col_credential')}</th>
              <th scope="col">{t(first.labelKey)}</th>
              <th scope="col">{t(second.labelKey)}</th>
              <th scope="col">{t('quota_ledger.col_resets')}</th>
              <th scope="col">
                <span className={styles.srOnly}>{t('quota_ledger.col_actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ledgers.map((ledger) =>
              ledger.provider === 'claude' ? (
                <ClaudeLedgerRow
                  key={getQuotaCacheKey(ledger.entry.file)}
                  ledger={ledger}
                  now={now}
                  {...actions}
                />
              ) : (
                <CodexLedgerRow
                  key={getQuotaCacheKey(ledger.entry.file)}
                  ledger={ledger}
                  now={now}
                  {...actions}
                />
              )
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface RowProps<TLedger extends LedgerEntry> extends LedgerActions {
  ledger: TLedger;
  now: number;
}

/** The reset column and button, whichever provider flow backs them. */
interface RowResets {
  count: number | null;
  disabled: boolean;
  busy: boolean;
  labelKey: 'quota_ledger.use_reset' | 'quota_ledger.retry_reset';
  message: string | null;
  onUse: () => void;
}

function ClaudeLedgerRow({
  ledger,
  now,
  canUseActions,
  resettingQuotaName,
  onRefresh,
}: RowProps<Extract<LedgerEntry, { provider: 'claude' }>>) {
  const { t } = useTranslation();
  const { entry, quota } = ledger;
  const status = quota?.status ?? 'idle';
  const canRefresh = canUseActions && !entry.file.disabled;
  const resetting = resettingQuotaName === getQuotaCacheKey(entry.file);
  const refresh = () => onRefresh(entry);
  const grants = useClaudeResetGrants(
    entry.file,
    status !== 'idle',
    !canRefresh || status === 'loading' || resetting,
    quota,
    refresh
  );

  return (
    <LedgerRow
      ledger={ledger}
      now={now}
      plan={quota?.planType ? t(`claude_quota.${quota.planType}`) : null}
      resets={{
        count: grants.count,
        disabled: grants.blocked,
        busy: grants.busy,
        labelKey:
          grants.buttonLabel === 'retry' ? 'quota_ledger.retry_reset' : 'quota_ledger.use_reset',
        message: grants.message ? t(`claude_reset.${grants.message}`) : null,
        onUse: grants.confirm,
      }}
      refreshDisabled={isQuotaRefreshDisabled(
        canRefresh,
        status === 'loading',
        resetting || grants.busy
      )}
      onRefresh={refresh}
    />
  );
}

function CodexLedgerRow({
  ledger,
  now,
  canUseActions,
  resettingQuotaName,
  onRefresh,
  onReset,
}: RowProps<Extract<LedgerEntry, { provider: 'codex' }>>) {
  const { t } = useTranslation();
  const { entry, quota } = ledger;
  const loading = quota?.status === 'loading';
  const loaded = quota?.status === 'success' ? quota : undefined;
  const canRefresh = canUseActions && !entry.file.disabled;
  const resetting = resettingQuotaName === getQuotaCacheKey(entry.file);
  const hasCredit = loaded ? (CODEX_CONFIG.canResetQuota?.(loaded) ?? false) : false;

  return (
    <LedgerRow
      ledger={ledger}
      now={now}
      plan={codexPlanLabel(t, quota?.planType)}
      resets={{
        count: loaded?.rateLimitResetCreditsAvailableCount ?? null,
        disabled: !hasCredit || !canRefresh || loading || resetting,
        busy: resetting,
        labelKey: 'quota_ledger.use_reset',
        message: null,
        onUse: () => onReset(entry),
      }}
      refreshDisabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
      onRefresh={() => onRefresh(entry)}
    />
  );
}

interface LedgerRowProps {
  ledger: LedgerEntry;
  now: number;
  plan: string | null;
  resets: RowResets;
  refreshDisabled: boolean;
  onRefresh: () => void;
}

function LedgerRow({ ledger, now, plan, resets, refreshDisabled, onRefresh }: LedgerRowProps) {
  const { t, i18n } = useTranslation();
  const { entry, quota, provider } = ledger;
  const name = getQuotaDisplayName(entry.file);
  const status = quota?.status ?? 'idle';
  const prefix = I18N_PREFIX[provider];
  const observedMs = quota?.observedAt ? Date.parse(quota.observedAt) : Number.NaN;
  // The minute clock can trail a read that just landed, so a fresh read is "just now".
  const readLabel = !Number.isFinite(observedMs)
    ? null
    : now - observedMs < MINUTE_MS
      ? t('quota_ledger.read_just_now')
      : t('quota_ledger.read_ago', {
          time: formatRelativeInstant(observedMs, now, i18n.resolvedLanguage),
        });
  const meta = [plan, readLabel].filter(Boolean).join(' · ');
  const hasWindows = (quota?.windows.length ?? 0) > 0;
  const weeklyResetMs = ledgerLimit(ledger, POOL_WINDOW_ID[provider])?.resetAtMs ?? null;
  const statusText =
    status === 'loading'
      ? t(`${prefix}.loading`)
      : status === 'error'
        ? t(`${prefix}.load_failed`, {
            message: resolveQuotaErrorMessage(
              t,
              quota?.errorStatus,
              quota?.error || t('common.unknown_error')
            ),
          })
        : status === 'success'
          ? t(`${prefix}.empty_windows`)
          : t('quota_ledger.not_loaded');

  return (
    <tr aria-busy={status === 'loading' || undefined}>
      <th scope="row" className={styles.credential}>
        <span className={styles.credentialName} title={name}>
          {name}
        </span>
        {meta && <span className={styles.detail}>{meta}</span>}
        {status === 'error' && hasWindows && (
          <span className={styles.warn}>{t('quota_ledger.stale')}</span>
        )}
      </th>
      {hasWindows ? (
        LEDGER_COLUMNS[provider].map((column) => (
          <td key={column.windowId} className={styles.limitCell}>
            <LimitCell limit={ledgerLimit(ledger, column.windowId)} now={now} />
          </td>
        ))
      ) : (
        <td colSpan={2} className={status === 'error' ? styles.errorCell : styles.statusCell}>
          {statusText}
        </td>
      )}
      <td className={styles.resetsCell}>
        <span>
          {resets.count === null
            ? t('quota_ledger.resets_unknown')
            : t('quota_ledger.resets_left', { count: resets.count })}
        </span>
        {weeklyResetMs !== null && (
          <span className={styles.detail}>
            {weeklyResetMs > now
              ? t('quota_ledger.window_ends_in', { span: formatSpan(t, weeklyResetMs - now) })
              : t('quota_ledger.reset_passed')}
          </span>
        )}
        {resets.message && (
          <span role="status" className={styles.warn}>
            {resets.message}
          </span>
        )}
      </td>
      <td className={styles.actionsCell}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t(resets.labelKey, { name })}
          title={t(resets.labelKey, { name })}
          aria-busy={resets.busy || undefined}
          disabled={resets.disabled}
          onClick={resets.onUse}
        >
          <IconSidebarQuickStart size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('quota_ledger.refresh', { name })}
          title={t('quota_ledger.refresh', { name })}
          aria-busy={status === 'loading' || undefined}
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          <IconRefreshCw size={16} aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}

function LimitCell({ limit, now }: { limit: LedgerLimit | null; now: number }) {
  const { t } = useTranslation();
  if (!limit) {
    return (
      <>
        <span className={styles.left}>—</span>
        <span className={styles.detail}>{t('quota_ledger.not_reported')}</span>
      </>
    );
  }
  const resetText =
    limit.resetAtMs === null
      ? t(limit.leftPercent >= 100 ? 'quota_ledger.full_no_window' : 'quota_ledger.reset_unknown')
      : limit.resetAtMs > now
        ? t('quota_ledger.resets_in', { span: formatSpan(t, limit.resetAtMs - now) })
        : t('quota_ledger.reset_passed');

  return (
    <div className={limit.low ? `${styles.limit} ${styles.limitLow}` : styles.limit}>
      <div className={styles.limitTop}>
        <span className={styles.left}>
          {t('quota_ledger.left', { percent: limit.leftPercent })}
        </span>
        {limit.low && <span className={styles.low}>{t('quota_ledger.low')}</span>}
      </div>
      <div className={styles.meter} aria-hidden="true">
        <div className={styles.meterFill} style={{ width: `${limit.leftPercent}%` }} />
      </div>
      <span className={styles.detail}>{resetText}</span>
    </div>
  );
}
