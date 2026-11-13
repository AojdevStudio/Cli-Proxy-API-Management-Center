/**
 * The controls every pool card shares: chart view, burn window, future usage,
 * and the two-week span pager.
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons';
import { formatMonthDay } from './ledgerModel';
import {
  BURN_WINDOW_HOURS,
  FUTURE_USAGES,
  FUTURE_USAGE_LABEL_KEY,
  POOL_VIEWS,
  POOL_VIEW_LABEL_KEY,
  weekPager,
  type PoolControls,
} from './poolControls';
import { Segmented } from './Segmented';
import styles from './QuotaLedger.module.scss';

interface PoolControlsBarProps {
  controls: PoolControls;
  onChange: (patch: Partial<PoolControls>) => void;
  span: { startMs: number; endMs: number };
  now: number;
}

export function PoolControlsBar({ controls, onChange, span, now }: PoolControlsBarProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const burnLabelId = useId();
  const usageLabelId = useId();
  const pager = weekPager(controls.weekOffset, now);

  return (
    <div className={styles.controls} role="toolbar" aria-label={t('quota_ledger.controls_label')}>
      <Segmented
        ariaLabel={t('quota_ledger.view_label')}
        options={POOL_VIEWS.map((view) => ({ value: view, label: t(POOL_VIEW_LABEL_KEY[view]) }))}
        value={controls.view}
        onChange={(view) => onChange({ view })}
      />
      <span id={burnLabelId} className={styles.controlLabel}>
        {t('quota_ledger.burn_window_label')}
      </span>
      <Segmented
        ariaLabelledBy={burnLabelId}
        options={BURN_WINDOW_HOURS.map((hours) => ({
          value: hours,
          label: t('quota_ledger.burn_window_option', { hours }),
        }))}
        value={controls.burnWindowHours}
        onChange={(burnWindowHours) => onChange({ burnWindowHours })}
      />
      <span id={usageLabelId} className={styles.controlLabel}>
        {t('quota_ledger.future_usage_label')}
      </span>
      <Select
        className={styles.usageSelect}
        size="sm"
        fullWidth={false}
        ariaLabelledBy={usageLabelId}
        value={controls.futureUsage}
        options={FUTURE_USAGES.map((usage) => ({
          value: usage,
          label: t(FUTURE_USAGE_LABEL_KEY[usage]),
        }))}
        onChange={(value) => {
          const futureUsage = FUTURE_USAGES.find((usage) => usage === value);
          if (futureUsage) onChange({ futureUsage });
        }}
      />
      <span className={styles.rangeLabel}>
        {t('quota_ledger.range', {
          from: formatMonthDay(span.startMs, locale),
          to: formatMonthDay(span.endMs - 1, locale),
        })}
      </span>
      <div className={styles.pager}>
        <button
          type="button"
          className={styles.pageButton}
          aria-label={t('quota_ledger.page_earlier')}
          disabled={!pager.earlier}
          onClick={() => onChange({ weekOffset: controls.weekOffset - 1 })}
        >
          <IconChevronLeft size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.pageButton}
          disabled={!pager.today}
          onClick={() => onChange({ weekOffset: 0 })}
        >
          {t('quota_ledger.page_today')}
        </button>
        <button
          type="button"
          className={styles.pageButton}
          aria-label={t('quota_ledger.page_later')}
          disabled={!pager.later}
          onClick={() => onChange({ weekOffset: controls.weekOffset + 1 })}
        >
          <IconChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
