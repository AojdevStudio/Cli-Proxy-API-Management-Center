/**
 * Keeps the last good quota numbers and Claude reset counts in this browser, per backend
 * address, so opening the app shows them at once while fresh reads run behind them. Both hold
 * display data only, never tokens or keys. Kept only for a session that remembers its password,
 * like the key itself. Logout deletes it at once.
 */

import { apiClient } from '@/services/api/client';
import { useAuthStore, useQuotaStore } from '@/stores';
import { isRecord } from '@/utils/helpers';
import { cardResetReads, type SavedCardRead } from './providers/claude/resetGrantReads';

const STORAGE_KEY = 'quotaCache.v1';
const SAVE_DELAY_MS = 1000;

const QUOTA_MAPS = [
  'antigravityQuota',
  'claudeQuota',
  'codexQuota',
  'devinQuota',
  'kimiQuota',
  'metaQuota',
  'pluginQuota',
  'xaiQuota',
] as const;

type QuotaState = ReturnType<typeof useQuotaStore.getState>;
type QuotaMaps = { [K in (typeof QUOTA_MAPS)[number]]: QuotaState[K] };

interface SavedQuota {
  apiBase: string;
  maps: QuotaMaps;
  settledAt: Record<string, number>;
  resets: Record<string, SavedCardRead>;
}

const everyValue = (value: unknown, check: (entry: Record<string, unknown>) => boolean) =>
  isRecord(value) && Object.values(value).every((entry) => isRecord(entry) && check(entry));

/** The saved copy is read back from storage, so its whole shape is checked before use. */
const isSavedQuota = (value: unknown, apiBase: string): value is SavedQuota => {
  if (!isRecord(value) || value.apiBase !== apiBase || !isRecord(value.maps)) return false;
  const maps = value.maps;
  return (
    isRecord(value.settledAt) &&
    Object.values(value.settledAt).every((at) => typeof at === 'number') &&
    everyValue(
      value.resets,
      (read) =>
        typeof read.readAt === 'number' &&
        isRecord(read.status) &&
        Array.isArray(read.status.grants) &&
        read.status.grants.every(isRecord)
    ) &&
    QUOTA_MAPS.every((name) => everyValue(maps[name], (state) => state.status === 'success'))
  );
};

/** Puts the saved numbers for this backend back into the quota store. */
export function restoreQuotaCache(apiBase: string): void {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    // A copy this version cannot read is worth nothing. Fresh reads replace it.
    removeSaved();
    return;
  }
  if (!isSavedQuota(saved, apiBase)) return;
  useQuotaStore.setState({ ...saved.maps, settledAt: saved.settledAt });
  cardResetReads.restore(saved.resets, apiClient.getConnectionRevision());
}

/** Storage can be blocked or missing. Then there is simply no saved copy to remove. */
const removeSaved = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was saved where storage cannot be reached.
  }
};

const successesOnly = <T extends { status: string }>(map: Record<string, T>) =>
  Object.fromEntries(Object.entries(map).filter(([, state]) => state.status === 'success'));

const save = () => {
  const { isAuthenticated, apiBase, rememberPassword } = useAuthStore.getState();
  const state = useQuotaStore.getState();
  if (!isAuthenticated || !apiBase || !rememberPassword) {
    removeSaved();
    return;
  }
  const maps: QuotaMaps = {
    antigravityQuota: successesOnly(state.antigravityQuota),
    claudeQuota: successesOnly(state.claudeQuota),
    codexQuota: successesOnly(state.codexQuota),
    devinQuota: successesOnly(state.devinQuota),
    kimiQuota: successesOnly(state.kimiQuota),
    metaQuota: successesOnly(state.metaQuota),
    pluginQuota: successesOnly(state.pluginQuota),
    xaiQuota: successesOnly(state.xaiQuota),
  };
  const saved: SavedQuota = {
    apiBase,
    maps,
    settledAt: state.settledAt,
    resets: cardResetReads.saved(apiClient.getConnectionRevision()),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage full or blocked: the app still works, it just starts without numbers next time.
  }
};

/**
 * Saves the quota store a moment after it changes, and drops the copy on logout. Returns a
 * stop function that ends the subscriptions and any pending save.
 */
export function startQuotaPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      save();
    }, SAVE_DELAY_MS);
  };
  const stops = [
    useQuotaStore.subscribe((state, previous) => {
      if (
        state.settledAt !== previous.settledAt ||
        QUOTA_MAPS.some((name) => state[name] !== previous[name])
      ) {
        schedule();
      }
    }),
    cardResetReads.subscribe(schedule),
    useAuthStore.subscribe((state, previous) => {
      if (state.isAuthenticated === previous.isAuthenticated) return;
      if (state.isAuthenticated) schedule();
      else removeSaved();
    }),
  ];
  return () => {
    if (timer) clearTimeout(timer);
    stops.forEach((stop) => stop());
  };
}
