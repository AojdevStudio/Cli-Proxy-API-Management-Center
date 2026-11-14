/**
 * Keeps the last good quota numbers in this browser, per backend address, so opening the app
 * shows them at once while fresh reads run behind them. Quota states hold display numbers
 * only, never tokens or keys. Login and logout empty the in-memory cache, and the saved copy
 * follows it.
 */

import { useAuthStore } from './useAuthStore';
import { useQuotaStore } from './useQuotaStore';

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
}

const isSavedQuota = (value: unknown, apiBase: string): value is SavedQuota => {
  if (typeof value !== 'object' || value === null) return false;
  const saved = value as Record<string, unknown>;
  return (
    saved.apiBase === apiBase &&
    typeof saved.settledAt === 'object' &&
    typeof saved.maps === 'object' &&
    saved.maps !== null &&
    QUOTA_MAPS.every((name) => typeof (saved.maps as Record<string, unknown>)[name] === 'object')
  );
};

/** Puts the saved numbers for this backend back into the quota store. */
export function restoreQuotaCache(apiBase: string): void {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    // A copy this version cannot read is worth nothing. Fresh reads replace it.
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  if (!isSavedQuota(saved, apiBase)) return;
  useQuotaStore.setState({ ...saved.maps, settledAt: saved.settledAt });
}

const successesOnly = <T extends { status: string }>(map: Record<string, T>) =>
  Object.fromEntries(Object.entries(map).filter(([, state]) => state.status === 'success'));

const save = () => {
  const { isAuthenticated, apiBase } = useAuthStore.getState();
  const state = useQuotaStore.getState();
  if (!isAuthenticated || !apiBase) {
    localStorage.removeItem(STORAGE_KEY);
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
  const saved: SavedQuota = { apiBase, maps, settledAt: state.settledAt };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage full or blocked: the app still works, it just starts without numbers next time.
  }
};

/** Saves the quota store a moment after it changes, and drops the copy on logout. */
export function startQuotaPersistence(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      save();
    }, SAVE_DELAY_MS);
  };
  useQuotaStore.subscribe((state, previous) => {
    if (
      state.settledAt !== previous.settledAt ||
      QUOTA_MAPS.some((name) => state[name] !== previous[name])
    ) {
      schedule();
    }
  });
  useAuthStore.subscribe((state, previous) => {
    if (state.isAuthenticated !== previous.isAuthenticated) schedule();
  });
}
