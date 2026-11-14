import { useEffect } from 'react';
import { MINUTE_MS } from '@/utils/time/durations';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { quotaSettledAt, type LoadQuotaOptions } from './useQuotaBatchLoader';

/** Each read calls the provider's usage API, so a shown number is reused for this long. */
export const QUOTA_STALE_MS = 5 * MINUTE_MS;

/**
 * Loads the visible credentials' quota without a click: the ones never read, and the ones
 * read more than QUOTA_STALE_MS ago. Numbers already on screen stay there while they reload.
 */
export function useQuotaAutoLoad(
  entries: QuotaFileEntry[],
  disabled: boolean,
  getQuota: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  loadQuota: (targets: QuotaFileEntry[], options?: LoadQuotaOptions) => Promise<void>
) {
  useEffect(() => {
    if (disabled) return;
    const now = Date.now();
    const targets = entries.filter((entry) => {
      const state = getQuota(entry);
      if (state?.status === 'loading') return false;
      const settled = quotaSettledAt(getQuotaCacheKey(entry.file));
      return !state || settled === undefined || now - settled >= QUOTA_STALE_MS;
    });
    if (targets.length > 0) void loadQuota(targets, { background: true });
  }, [disabled, entries, getQuota, loadQuota]);
}
