/**
 * Ledger layout and row data, React-free.
 *
 * The ledger draws only providers whose weekly windows make a pool. Each one
 * names its two limit columns by the window ids its data layer emits.
 */

import type { TFunction } from 'i18next';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { MINUTE_MS } from '@/utils/time/durations';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import {
  poolCredentialOf,
  summarizePool,
  type PoolCredential,
  type PoolProvider,
  type PoolSummary,
} from '../pool';

/** Ledger panels in page order. */
export const LEDGER_PROVIDERS: readonly PoolProvider[] = ['claude', 'codex'];

export const isLedgerProvider = (type: QuotaProviderType): type is PoolProvider =>
  type === 'claude' || type === 'codex';

export interface LedgerColumn {
  windowId: string;
  labelKey: string;
}

export const LEDGER_COLUMNS: Record<PoolProvider, readonly [LedgerColumn, LedgerColumn]> = {
  claude: [
    { windowId: 'seven-day', labelKey: 'claude_quota.seven_day' },
    { windowId: 'seven-day-fable', labelKey: 'claude_quota.seven_day_fable' },
  ],
  codex: [
    { windowId: 'weekly', labelKey: 'codex_quota.secondary_window' },
    { windowId: 'five-hour', labelKey: 'codex_quota.primary_window' },
  ],
};

/** A limit under this much left reads "Low". */
export const LOW_LEFT_PERCENT = 15;

export type LedgerEntry =
  | { provider: 'claude'; entry: QuotaFileEntry; quota: ClaudeQuotaState | undefined }
  | { provider: 'codex'; entry: QuotaFileEntry; quota: CodexQuotaState | undefined };

/** The quota store erases provider state types. The entry's provider restores them, here only. */
export function toLedgerEntry(
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined
): LedgerEntry | null {
  if (entry.type === 'claude') {
    return { provider: 'claude', entry, quota: quota as ClaudeQuotaState | undefined };
  }
  if (entry.type === 'codex') {
    return { provider: 'codex', entry, quota: quota as CodexQuotaState | undefined };
  }
  return null;
}

export interface LedgerLimit {
  leftPercent: number;
  resetAtMs: number | null;
  low: boolean;
}

export function ledgerLimit(ledger: LedgerEntry, windowId: string): LedgerLimit | null {
  const window = ledger.quota?.windows.find((candidate) => candidate.id === windowId);
  if (!window || window.usedPercent === null) return null;
  const leftPercent = Math.round(Math.min(100, Math.max(0, 100 - window.usedPercent)));
  return {
    leftPercent,
    resetAtMs: window.resetAtMs ?? null,
    low: leftPercent < LOW_LEFT_PERCENT,
  };
}

export function ledgerPool(entries: readonly LedgerEntry[]): PoolSummary {
  const credentials = entries.map((ledger) =>
    poolCredentialOf(
      ledger.provider,
      getQuotaCacheKey(ledger.entry.file),
      getQuotaDisplayName(ledger.entry.file),
      ledger.quota?.windows ?? []
    )
  );
  const loaded = credentials.filter((credential): credential is PoolCredential => !!credential);
  return summarizePool(loaded, credentials.length - loaded.length);
}

/** Two-unit countdown such as "19h 21m" or "2d 10h". */
export function formatSpan(t: TFunction, ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE_MS));
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.floor((minutes % (24 * 60)) / 60);
  const m = minutes % 60;
  if (d > 0) return t('quota_ledger.span_days', { d, h });
  if (h > 0) return t('quota_ledger.span_hours', { h, m });
  return t('quota_ledger.span_minutes', { m });
}

/** Weekday and clock time, such as "Wed 1:18 PM". */
export const formatWeekdayTime = (ms: number, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(
    ms
  );

/** Month and day, such as "Nov 21". */
export const formatMonthDay = (ms: number, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(ms);
