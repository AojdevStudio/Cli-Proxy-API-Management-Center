import { useEffect } from 'react';
import { authFilesApi } from '@/services/api';
import { useQuotaStore } from '@/stores';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { classifyQuotaFiles } from '../logic';
import { QUOTA_ADAPTERS } from '../providers';
import { QUOTA_STALE_MS } from './useQuotaAutoLoad';
import { useQuotaBatchLoader } from './useQuotaBatchLoader';

/**
 * Reads quota once when the app opens, so the Quota and Usage screens find their numbers
 * ready instead of starting the provider reads on the click. Skips numbers read in the last
 * QUOTA_STALE_MS. The screens keep their own refresh while they are open.
 */
export function useQuotaPrefetch(connected: boolean) {
  const { loadQuota } = useQuotaBatchLoader();

  useEffect(() => {
    if (!connected) return;
    let active = true;
    void authFilesApi.listShared().then(
      ({ files }) => {
        if (!active) return;
        const state = useQuotaStore.getState();
        const now = Date.now();
        const targets = classifyQuotaFiles(files).filter(({ type, file }) => {
          const key = getQuotaCacheKey(file);
          const quota = QUOTA_ADAPTERS[type].storeSelector(state)[key];
          const settled = state.settledAt[key];
          if (quota?.status === 'loading') return false;
          return !quota || settled === undefined || now - settled >= QUOTA_STALE_MS;
        });
        if (targets.length > 0) void loadQuota(targets, { background: true });
      },
      // Prefetch is optional. The screens read the list again and report a failure there.
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [connected, loadQuota]);
}
