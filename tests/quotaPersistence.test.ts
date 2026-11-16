import { afterEach, beforeEach, expect, test } from 'bun:test';
import { restoreQuotaCache, startQuotaPersistence } from '@/features/quota/quotaPersistence';
import { useAuthStore } from '@/stores/useAuthStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { ClaudeQuotaState } from '@/types';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let values: Map<string, string>;
let stopPersistence: () => void;
const base = 'http://proxy.example.com';
const quota: ClaudeQuotaState = {
  status: 'success',
  windows: [],
  observedAt: '2026-11-14T12:00:00Z',
};

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  useQuotaStore.getState().clearQuotaCache();
  stopPersistence = startQuotaPersistence();
});

afterEach(() => {
  stopPersistence();
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const settle = () => Bun.sleep(1100);
const fill = () =>
  useQuotaStore.setState({
    claudeQuota: { a: quota, b: { status: 'error', windows: [], error: 'x' } },
    settledAt: { a: 1, b: 1 },
  });

test('keeps good numbers for a remembered session and brings them back for that backend only', async () => {
  useAuthStore.setState({ isAuthenticated: true, apiBase: base, rememberPassword: true });
  fill();
  await settle();
  useQuotaStore.getState().clearQuotaCache();
  restoreQuotaCache('http://other.example.com');
  expect(useQuotaStore.getState().claudeQuota).toEqual({});
  restoreQuotaCache(base);
  expect(useQuotaStore.getState().claudeQuota).toEqual({ a: quota });
  useAuthStore.setState({ isAuthenticated: false });
  expect(values.has('quotaCache.v1')).toBe(false);
});

test('saves nothing when the session does not remember its password', async () => {
  useAuthStore.setState({ isAuthenticated: true, apiBase: base, rememberPassword: false });
  fill();
  await settle();
  expect(values.has('quotaCache.v1')).toBe(false);
});

test('keeps dated Claude values after a failed refresh across a remembered session reload', async () => {
  useAuthStore.setState({ isAuthenticated: true, apiBase: base, rememberPassword: true });
  useQuotaStore.getState().setClaudeQuota({ a: quota });
  useQuotaStore.getState().setClaudeQuota({
    a: { status: 'error', windows: [], error: '429 Rate limited', errorStatus: 429 },
  });
  await settle();
  expect(values.get('quotaCache.v1')).not.toContain('429 Rate limited');
  useQuotaStore.getState().clearQuotaCache();
  restoreQuotaCache(base);
  expect(useQuotaStore.getState().claudeQuota.a).toMatchObject({
    observedAt: quota.observedAt,
    stale: true,
  });
});

test('ignores a saved copy with a broken shape instead of failing at startup', () => {
  values.set(
    'quotaCache.v1',
    JSON.stringify({ apiBase: base, maps: {}, settledAt: {}, resets: null })
  );
  expect(() => restoreQuotaCache(base)).not.toThrow();
  expect(useQuotaStore.getState().claudeQuota).toEqual({});
});
