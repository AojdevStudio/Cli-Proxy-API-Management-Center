/**
 * Usage page data. Two independent halves:
 * - login limits: the auth files list plus the quota feature's own loader and
 *   store, so the page never reads quota from anywhere else;
 * - usage numbers: the reader through CPA's relay (services/api/usage.ts).
 * A reader outage leaves the login half untouched.
 *
 * Loads on open, when the browser tab regains focus, and on refresh. No timer,
 * except one retry 2 s after a warming answer, since warming ends on its own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFilesApi } from '@/services/api';
import { usageApi } from '@/services/api/usage';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { accountTokenMap, buildLoginRows, combineReader, type LoginRow } from '../logic';
import type { ReaderSnapshot, SessionTurns, UsageResult } from '../types';

const WARMING_RETRY_MS = 2000;
/** Focus events arrive in bursts (window focus plus visibility). One load per burst. */
const FOCUS_DEBOUNCE_MS = 10_000;

export interface UsageData {
  now: number;
  logins: LoginRow[];
  loginsLoading: boolean;
  loginsError: string;
  reader: UsageResult<ReaderSnapshot> | null;
  turns: ReadonlyMap<string, UsageResult<SessionTurns>>;
  refreshing: boolean;
  refresh: () => void;
  loadTurns: (ids: string[]) => void;
}

export function useUsageData(): UsageData {
  const connected = useAuthStore((state) => state.connectionStatus) === 'connected';
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const { batchLoading, loadQuota } = useQuotaBatchLoader();

  const [now, setNow] = useState(() => Date.now());
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState('');
  const [reader, setReader] = useState<UsageResult<ReaderSnapshot> | null>(null);
  const [readerLoading, setReaderLoading] = useState(true);
  const [turns, setTurns] = useState<ReadonlyMap<string, UsageResult<SessionTurns>>>(new Map());

  const requestRef = useRef(0);
  const warmingRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadRef = useRef(0);

  const loadReader = useCallback((requestId: number) => {
    const run = async (allowRetry: boolean) => {
      const [health, today, week, sessions] = await Promise.all([
        usageApi.health(),
        usageApi.overview('today'),
        usageApi.overview('7d'),
        usageApi.sessions('today'),
      ]);
      if (requestId !== requestRef.current) return;
      const combined = combineReader({ health, today, week, sessions });
      setReader(combined);
      setReaderLoading(false);
      if (combined.status === 'warming' && allowRetry) {
        warmingRetryRef.current = setTimeout(() => {
          warmingRetryRef.current = null;
          void run(false);
        }, WARMING_RETRY_MS);
      }
    };
    setReaderLoading(true);
    void run(true);
  }, []);

  const loadLogins = useCallback(
    async (requestId: number) => {
      setFilesLoading(true);
      setFilesError('');
      const isCurrent = () =>
        requestId === requestRef.current &&
        sessionGeneration === useQuotaStore.getState().cacheGeneration;
      try {
        const data = await authFilesApi.list();
        if (!isCurrent()) return;
        const list = data?.files ?? [];
        setFiles(list);
        const targets = classifyQuotaFiles(list).filter(
          (entry) => entry.type === 'claude' || entry.type === 'codex'
        );
        void loadQuota(targets);
      } catch (err: unknown) {
        if (!isCurrent()) return;
        setFilesError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isCurrent()) setFilesLoading(false);
      }
    },
    [loadQuota, sessionGeneration]
  );

  const refresh = useCallback(() => {
    const requestId = ++requestRef.current;
    if (warmingRetryRef.current) {
      clearTimeout(warmingRetryRef.current);
      warmingRetryRef.current = null;
    }
    lastLoadRef.current = Date.now();
    setNow(lastLoadRef.current);
    setTurns(new Map());
    if (!connected) {
      setFiles([]);
      setReader(null);
      setFilesLoading(false);
      setReaderLoading(false);
      return;
    }
    void loadLogins(requestId);
    loadReader(requestId);
  }, [connected, loadLogins, loadReader]);

  useHeaderRefresh(refresh);

  useEffect(() => {
    refresh();
    return () => {
      requestRef.current += 1;
      if (warmingRetryRef.current) clearTimeout(warmingRetryRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadRef.current < FOCUS_DEBOUNCE_MS) return;
      refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // Quota reads land after the refresh started. Ages are measured from when they landed.
  useEffect(() => {
    if (!batchLoading) setNow(Date.now());
  }, [batchLoading]);

  const loadTurns = useCallback(
    (ids: string[]) => {
      const requestId = requestRef.current;
      const wanted = ids.filter((id) => !turns.has(id));
      if (wanted.length === 0) return;
      void Promise.all(wanted.map(async (id) => [id, await usageApi.session(id)] as const)).then(
        (results) => {
          if (requestId !== requestRef.current) return;
          setTurns((prev) => new Map([...prev, ...results]));
        }
      );
    },
    [turns]
  );

  const accountTokens = useMemo(
    () => (reader?.status === 'ready' ? accountTokenMap(reader.data.today) : null),
    [reader]
  );

  const logins = useMemo(
    () =>
      buildLoginRows(
        classifyQuotaFiles(files),
        { claude: claudeQuota, codex: codexQuota },
        accountTokens,
        now
      ),
    [accountTokens, claudeQuota, codexQuota, files, now]
  );

  return {
    now,
    logins,
    loginsLoading: filesLoading,
    loginsError: filesError,
    reader,
    turns,
    refreshing: filesLoading || batchLoading || readerLoading,
    refresh,
    loadTurns,
  };
}
