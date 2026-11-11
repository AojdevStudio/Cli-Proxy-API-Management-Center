/**
 * Recorded pool history for the Ledger, one reader request per ledger provider.
 *
 * Follows the Usage page's reader rhythm: loads when the Ledger shows, on an
 * explicit refresh, and when the tab regains focus, with one retry after a
 * warming answer. No timer otherwise. Every answer is kept under the quota
 * cache generation it was asked in, so a connection switch or logout hides it
 * at once and a late answer never lands in the new session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usageApi } from '@/services/api/usage';
import type { QuotaHistoryQuery } from '@/services/api/quotaHistoryContract';
import { useAuthStore, useQuotaStore } from '@/stores';
import { FOCUS_DEBOUNCE_MS, WARMING_RETRY_MS } from '@/features/usage/hooks/useUsageData';
import type { UsageResult } from '@/features/usage/types';
import { historyRangeFor, type QuotaHistory } from '../history';
import { LEDGER_PROVIDERS } from '../ledger/ledgerModel';
import type { PoolProvider } from '../pool';
import { timelineSpan } from '../quotaTimelineModel';

type HistoryResult = UsageResult<QuotaHistory>;

interface QuotaHistoryLoaderOptions {
  fetch?: (query: Required<QuotaHistoryQuery>) => Promise<HistoryResult>;
  commit: (generation: number, provider: PoolProvider, result: HistoryResult) => void;
  warmingRetryMs?: number;
}

/** React-free request lifecycle, so the generation and supersede rules test without a DOM. */
export function createQuotaHistoryLoader({
  fetch = usageApi.quotaHistory,
  commit,
  warmingRetryMs = WARMING_RETRY_MS,
}: QuotaHistoryLoaderOptions) {
  let request = 0;
  const retries = new Set<ReturnType<typeof setTimeout>>();

  const stop = () => {
    request += 1;
    retries.forEach(clearTimeout);
    retries.clear();
  };

  const load = (nowMs: number) => {
    stop();
    const requestId = request;
    const { cacheGeneration } = useQuotaStore.getState();
    const isCurrent = () =>
      requestId === request && cacheGeneration === useQuotaStore.getState().cacheGeneration;
    // The chart draws history from the start of its local-calendar span.
    const range = historyRangeFor(timelineSpan('weekly', 0, nowMs).startMs, nowMs);

    LEDGER_PROVIDERS.forEach((provider) => {
      const run = async (allowRetry: boolean) => {
        const result = await fetch({ provider, range });
        if (!isCurrent()) return;
        commit(cacheGeneration, provider, result);
        if (result.status === 'warming' && allowRetry) {
          const retry = setTimeout(() => {
            retries.delete(retry);
            void run(false);
          }, warmingRetryMs);
          retries.add(retry);
        }
      };
      void run(true);
    });
  };

  return { load, stop };
}

interface Loaded {
  generation: number;
  results: Partial<Record<PoolProvider, HistoryResult>>;
}

export interface QuotaHistoryState {
  /** Parsed history per provider, only for providers whose last answer was ready. */
  history: Partial<Record<PoolProvider, QuotaHistory>>;
  reload: () => void;
}

export function useQuotaHistory(active: boolean): QuotaHistoryState {
  const connected = useAuthStore((state) => state.connectionStatus) === 'connected';
  const generation = useQuotaStore((state) => state.cacheGeneration);
  const [loaded, setLoaded] = useState<Loaded>({ generation: -1, results: {} });
  const lastLoadRef = useRef(0);
  const [loader] = useState(() =>
    createQuotaHistoryLoader({
      commit: (answeredIn, provider, result) =>
        setLoaded((prev) => ({
          generation: answeredIn,
          results: { ...(prev.generation === answeredIn ? prev.results : {}), [provider]: result },
        })),
    })
  );

  const reload = useCallback(() => {
    if (!active || !connected) return;
    lastLoadRef.current = Date.now();
    loader.load(Date.now());
  }, [active, connected, loader]);

  // A new cache generation is a new connection, so it loads again.
  useEffect(() => {
    reload();
    return loader.stop;
  }, [generation, loader, reload]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadRef.current < FOCUS_DEBOUNCE_MS) return;
      reload();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [active, reload]);

  const history = useMemo(() => {
    const ready: Partial<Record<PoolProvider, QuotaHistory>> = {};
    if (loaded.generation !== generation) return ready;
    LEDGER_PROVIDERS.forEach((provider) => {
      const result = loaded.results[provider];
      if (result?.status === 'ready') ready[provider] = result.data;
    });
    return ready;
  }, [generation, loaded]);

  return { history, reload };
}
