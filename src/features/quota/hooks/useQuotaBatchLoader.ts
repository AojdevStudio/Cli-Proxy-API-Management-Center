/**
 * 混合提供商批量额度加载（原 useQuotaLoader 的跨分区泛化）。
 *
 * 保留的三道守卫与旧实现逐一对应：
 * - loadingRef：并发批量加载去重；
 * - requestIdRef：被超越的响应直接丢弃；
 * - cacheGeneration：断线重连后过期请求不得写入新会话缓存。
 * 提交按 provider 分组进行 —— 快的提供商先落地，不等慢的。
 * A credential that any loader is already reading is left out, so the app-open read, the
 * screens' own loads, and Usage never ask a provider twice for the same numbers. Only the
 * newest read of a credential may commit, so an older read never overwrites a newer one.
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent, useQuotaStore } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { AuthFileItem } from '@/types';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from '../providers';
import { enrichQuotaInBackground } from '../quotaEnrichment';
import type { QuotaProviderType } from '../providers/types';

interface BatchFetchResult {
  name: string;
  cacheKey: string;
  status: 'success' | 'error';
  data?: unknown;
  error?: string;
  errorStatus?: number;
}

export interface LoadQuotaOptions {
  /** Keep a credential's shown numbers on screen while its reload runs. */
  background?: boolean;
}

/** The newest read per credential and cache generation, across every loader in the app. */
const latestReads = new Map<string, number>();
let readCount = 0;

/**
 * Read ownership for one credential. The key carries the cache generations, so a new session
 * or a changed credential never waits on obsolete work.
 */
export const quotaReads = {
  key: (file: AuthFileItem) => {
    const { cacheGeneration, fileGenerations } = useQuotaStore.getState();
    return JSON.stringify([
      cacheGeneration,
      fileGenerations[file.name] ?? 0,
      getQuotaCacheKey(file),
    ]);
  },
  inFlight: (readKey: string) => latestReads.has(readKey),
  begin: (readKey: string) => {
    const id = ++readCount;
    latestReads.set(readKey, id);
    return id;
  },
  isLatest: (readKey: string, id: number) => latestReads.get(readKey) === id,
  end: (readKey: string, id: number) => {
    if (latestReads.get(readKey) === id) latestReads.delete(readKey);
  },
};

export function useQuotaBatchLoader() {
  const { t } = useTranslation();
  const [batchLoading, setBatchLoading] = useState(false);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (requested: QuotaFileEntry[], { background = false }: LoadQuotaOptions = {}) => {
      if (loadingRef.current) return;
      const targets = requested.filter(({ file }) => !quotaReads.inFlight(quotaReads.key(file)));
      if (targets.length === 0) return;
      const reads = new Map(
        targets.map(({ file }) => {
          const readKey = quotaReads.key(file);
          return [file.name, { readKey, id: quotaReads.begin(readKey) }] as const;
        })
      );
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      const cacheGeneration = captureQuotaCacheGeneration();
      setBatchLoading(true);

      try {
        const groups = new Map<QuotaProviderType, QuotaFileEntry[]>();
        targets.forEach((entry) => {
          const group = groups.get(entry.type) ?? [];
          group.push(entry);
          groups.set(entry.type, group);
        });

        await Promise.all(
          Array.from(groups.entries()).map(async ([type, entries]) => {
            const adapter = QUOTA_ADAPTERS[type];
            const setQuota = getQuotaSetter(adapter);

            commitIfQuotaCacheCurrent(cacheGeneration, () => {
              setQuota((prev) => {
                const nextState = { ...prev };
                entries.forEach(({ file }) => {
                  const cacheKey = getQuotaCacheKey(file);
                  if (background && prev[cacheKey]?.status === 'success') return;
                  nextState[cacheKey] = adapter.buildLoadingState();
                });
                return nextState;
              });
            });

            const results = await Promise.all(
              entries.map(async ({ file }): Promise<BatchFetchResult> => {
                const cacheKey = getQuotaCacheKey(file);
                try {
                  const data = await adapter.fetchQuota(file, t);
                  return { name: file.name, cacheKey, status: 'success', data };
                } catch (err: unknown) {
                  const message = err instanceof Error ? err.message : t('common.unknown_error');
                  return {
                    name: file.name,
                    cacheKey,
                    status: 'error',
                    error: message,
                    errorStatus: getStatusFromError(err),
                  };
                }
              })
            );

            if (requestId !== requestIdRef.current) return;

            const committedStates = new Map<string, QuotaCardState>();
            setQuota((prev) => {
              const nextState = { ...prev };
              results.forEach((result) => {
                const read = reads.get(result.name);
                if (read && !quotaReads.isLatest(read.readKey, read.id)) return;
                // A failed background read keeps the numbers on screen and stays stale, so the
                // next check retries it.
                if (
                  background &&
                  result.status === 'error' &&
                  prev[result.cacheKey]?.status === 'success'
                ) {
                  return;
                }
                commitIfQuotaCacheCurrent(
                  cacheGeneration,
                  () => {
                    nextState[result.cacheKey] =
                      result.status === 'success'
                        ? adapter.buildSuccessState(result.data)
                        : adapter.buildErrorState(
                            result.error || t('common.unknown_error'),
                            result.errorStatus
                          );
                    committedStates.set(result.cacheKey, nextState[result.cacheKey]);
                  },
                  result.name
                );
              });
              return nextState;
            });
            if (committedStates.size > 0) {
              const settled = Date.now();
              useQuotaStore.setState((state) => ({
                settledAt: {
                  ...state.settledAt,
                  ...Object.fromEntries([...committedStates.keys()].map((key) => [key, settled])),
                },
              }));
            }
            results.forEach((result, index) => {
              const state = committedStates.get(result.cacheKey);
              if (result.status === 'success' && state) {
                void enrichQuotaInBackground(adapter, entries[index].file, result.data, state, t);
              }
            });
          })
        );
      } finally {
        reads.forEach(({ readKey, id }) => quotaReads.end(readKey, id));
        if (requestId === requestIdRef.current) {
          setBatchLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [t]
  );

  return { batchLoading, loadQuota };
}
