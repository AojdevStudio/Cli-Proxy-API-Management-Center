/**
 * Usage page data. Two independent halves:
 * - login limits: the auth files list plus the quota feature's own loader and
 *   store, so the page never reads quota from anywhere else;
 * - usage numbers: the reader through CPA's relay (services/api/usage.ts).
 * A reader outage leaves the login half untouched.
 *
 * Loads on open, when the browser tab regains focus, on refresh, and every
 * AUTO_REFRESH_MS while the tab is visible, checked on the minute clock (useNow).
 * One retry 2 s after a warming answer, since warming ends on its own. Quota
 * reloads keep the numbers on screen until the new ones land.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFilesApi } from '@/services/api';
import { usageApi } from '@/services/api/usage';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getErrorMessage } from '@/utils/helpers';
import { MINUTE_MS } from '@/utils/time/durations';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import {
  accountTokenMap,
  buildLoginRows,
  combineReader,
  isLoginEntry,
  SESSION_SPARK_COUNT,
  type LoginRow,
} from '../logic';
import type { ReaderSnapshot, SessionTurn, UsageResult } from '../types';

const WARMING_RETRY_MS = 2000;
/** Focus events arrive in bursts (window focus plus visibility). One load per burst. */
const FOCUS_DEBOUNCE_MS = 10_000;
/**
 * Codex clears its windows while it reloads, so a quota reload blanks those
 * rows for a few seconds. A focus refresh only reloads quota older than this.
 */
const FOCUS_QUOTA_MIN_AGE_MS = 5 * MINUTE_MS;
/** An open page reloads everything this often, so its numbers stay current. */
const AUTO_REFRESH_MS = 5 * MINUTE_MS;

export interface UsageData {
  now: number;
  logins: LoginRow[];
  loginsLoading: boolean;
  loginsError: string;
  reader: UsageResult<ReaderSnapshot> | null;
  turns: ReadonlyMap<string, UsageResult<SessionTurn[]>>;
  refreshing: boolean;
  onRefresh: () => void;
  onSessionsOpen: (ids: string[]) => void;
}

export function useUsageData(): UsageData {
  const now = useNow();
  const connected = useAuthStore((state) => state.connectionStatus) === 'connected';
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const { batchLoading, loadQuota } = useQuotaBatchLoader();

  const [files, setFiles] = useState<AuthFileItem[]>(() => authFilesApi.latestList()?.files ?? []);
  const [filesLoading, setFilesLoading] = useState(() => authFilesApi.latestList() === null);
  const [filesError, setFilesError] = useState('');
  const [reader, setReader] = useState<UsageResult<ReaderSnapshot> | null>(null);
  const [readerLoading, setReaderLoading] = useState(true);
  const [turns, setTurns] = useState<ReadonlyMap<string, UsageResult<SessionTurn[]>>>(new Map());

  const requestRef = useRef(0);
  const warmingRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadRef = useRef(0);
  const lastQuotaLoadRef = useRef(0);
  /** Set once Sessions has been opened. From then on every reader load refreshes its charts. */
  const wantTurnsRef = useRef(false);

  const entries = useMemo(() => classifyQuotaFiles(files).filter(isLoginEntry), [files]);

  const loadTurns = useCallback((requestId: number, ids: string[]) => {
    void Promise.all(ids.map(async (id) => [id, await usageApi.sessionTurns(id)] as const)).then(
      (results) => {
        if (requestId !== requestRef.current) return;
        setTurns((prev) => new Map([...prev, ...results]));
      }
    );
  }, []);

  const loadReader = useCallback(
    (requestId: number) => {
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
        if (combined.status === 'ready' && wantTurnsRef.current) {
          loadTurns(
            requestId,
            combined.data.sessions.slice(0, SESSION_SPARK_COUNT).map((session) => session.id)
          );
        }
        if (combined.status === 'warming' && allowRetry) {
          warmingRetryRef.current = setTimeout(() => {
            warmingRetryRef.current = null;
            void run(false);
          }, WARMING_RETRY_MS);
        }
      };
      setReaderLoading(true);
      void run(true);
    },
    [loadTurns]
  );

  const loadLogins = useCallback(
    async (requestId: number, withQuota: boolean) => {
      if (authFilesApi.latestList() === null) setFilesLoading(true);
      setFilesError('');
      const isCurrent = () =>
        requestId === requestRef.current &&
        sessionGeneration === useQuotaStore.getState().cacheGeneration;
      try {
        const { files: list } = await authFilesApi.listShared();
        if (!isCurrent()) return;
        setFiles(list);
        if (withQuota) {
          lastQuotaLoadRef.current = Date.now();
          void loadQuota(classifyQuotaFiles(list).filter(isLoginEntry), { background: true });
        }
      } catch (err: unknown) {
        if (!isCurrent()) return;
        setFilesError(getErrorMessage(err, String(err)));
      } finally {
        if (isCurrent()) setFilesLoading(false);
      }
    },
    [loadQuota, sessionGeneration]
  );

  const load = useCallback(
    (withQuota: boolean) => {
      const requestId = ++requestRef.current;
      if (warmingRetryRef.current) {
        clearTimeout(warmingRetryRef.current);
        warmingRetryRef.current = null;
      }
      lastLoadRef.current = Date.now();
      if (!connected) {
        setFiles([]);
        setReader(null);
        setFilesLoading(false);
        setReaderLoading(false);
        return;
      }
      void loadLogins(requestId, withQuota);
      loadReader(requestId);
    },
    [connected, loadLogins, loadReader]
  );

  const onRefresh = useCallback(() => load(true), [load]);

  useHeaderRefresh(onRefresh);

  useEffect(() => {
    onRefresh();
    return () => {
      requestRef.current += 1;
      if (warmingRetryRef.current) clearTimeout(warmingRetryRef.current);
    };
  }, [onRefresh]);

  useEffect(() => {
    if (document.visibilityState === 'hidden') return;
    if (now - lastLoadRef.current < AUTO_REFRESH_MS) return;
    load(true);
  }, [load, now]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadRef.current < FOCUS_DEBOUNCE_MS) return;
      load(Date.now() - lastQuotaLoadRef.current >= FOCUS_QUOTA_MIN_AGE_MS);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [load]);

  const onSessionsOpen = useCallback(
    (ids: string[]) => {
      wantTurnsRef.current = true;
      const missing = ids.filter((id) => !turns.has(id));
      if (missing.length > 0) loadTurns(requestRef.current, missing);
    },
    [loadTurns, turns]
  );

  const accountTokens = useMemo(
    () => (reader?.status === 'ready' ? accountTokenMap(reader.data.today) : null),
    [reader]
  );

  const logins = useMemo(
    () => buildLoginRows(entries, { claude: claudeQuota, codex: codexQuota }, accountTokens, now),
    [accountTokens, claudeQuota, codexQuota, entries, now]
  );

  return {
    now,
    logins,
    loginsLoading: filesLoading,
    loginsError: filesError,
    reader,
    turns,
    refreshing: filesLoading || batchLoading || readerLoading,
    onRefresh,
    onSessionsOpen,
  };
}
