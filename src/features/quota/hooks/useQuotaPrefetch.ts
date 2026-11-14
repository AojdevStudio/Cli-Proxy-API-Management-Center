import { useEffect } from 'react';
import { authFilesApi } from '@/services/api';
import { useQuotaStore } from '@/stores';
import { normalizeAuthIndex } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { classifyQuotaFiles } from '../logic';
import { QUOTA_ADAPTERS } from '../providers';
import { cardResetKey, cardResetReads } from '../providers/claude/resetGrantReads';
import { QUOTA_STALE_MS } from './useQuotaAutoLoad';
import { useQuotaBatchLoader } from './useQuotaBatchLoader';

/**
 * Reads quota once when the app opens, so the Quota and Usage screens find their numbers
 * ready instead of starting the provider reads on the click. Skips numbers read in the last
 * QUOTA_STALE_MS. Claude reset counts follow each fresh Claude read. The screens keep their
 * own refresh while they are open.
 */
export function useQuotaPrefetch(connected: boolean) {
  // Claude gets its own loader so its reset reads start when Claude lands, not the slowest.
  const { loadQuota: loadClaude } = useQuotaBatchLoader();
  const { loadQuota: loadOthers } = useQuotaBatchLoader();

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
        const claude = targets.filter(({ type }) => type === 'claude');
        const others = targets.filter(({ type }) => type !== 'claude');
        if (others.length > 0) void loadOthers(others, { background: true });
        if (claude.length === 0) return;
        void loadClaude(claude, { background: true }).then(() => {
          if (!active) return;
          const claudeQuota = useQuotaStore.getState().claudeQuota;
          claude.forEach(({ file }) => {
            const quota = claudeQuota[getQuotaCacheKey(file)];
            const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
            if (quota?.status !== 'success' || !authIndex) return;
            // A failed read leaves the card to read on its own schedule.
            void cardResetReads
              .prefetch(cardResetKey(file.name, authIndex), authIndex, quota)
              .catch(() => undefined);
          });
        });
      },
      // Prefetch is optional. The screens read the list again and report a failure there.
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [connected, loadClaude, loadOthers]);
}
