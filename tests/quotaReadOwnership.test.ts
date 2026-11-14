import { expect, test } from 'bun:test';
import { quotaReads } from '@/features/quota/hooks/useQuotaBatchLoader';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { AuthFileItem } from '@/types';

const file = { name: 'claude-a.json' } as AuthFileItem;

test('only the newest read of a credential may commit', () => {
  const key = quotaReads.key(file);
  const background = quotaReads.begin(key);
  const manual = quotaReads.begin(key);
  expect(quotaReads.isLatest(key, background)).toBe(false);
  expect(quotaReads.isLatest(key, manual)).toBe(true);
  quotaReads.end(key, background);
  expect(quotaReads.inFlight(key)).toBe(true);
  quotaReads.end(key, manual);
  expect(quotaReads.inFlight(key)).toBe(false);
});

test('a new session never waits on a read from the old one', () => {
  const oldKey = quotaReads.key(file);
  const oldRead = quotaReads.begin(oldKey);
  useQuotaStore.getState().clearQuotaCache();
  const newKey = quotaReads.key(file);
  expect(quotaReads.inFlight(newKey)).toBe(false);
  quotaReads.end(oldKey, oldRead);
});
