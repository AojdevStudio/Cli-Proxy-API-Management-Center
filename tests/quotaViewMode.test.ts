import { afterAll, describe, expect, test } from 'bun:test';
import { readQuotaViewMode, writeQuotaViewMode } from '@/features/quota/viewMode';

const originalWindow = (globalThis as { window?: unknown }).window;

const installLocalStorage = (getItem: (key: string) => string | null) => {
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => getItem(key) ?? store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  };
};

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe('quota view mode', () => {
  test('defaults to the ledger and remembers the cards choice', () => {
    installLocalStorage(() => null);
    expect(readQuotaViewMode()).toBe('ledger');
    writeQuotaViewMode('cards');
    expect(readQuotaViewMode()).toBe('cards');
  });

  test('falls back to the ledger when storage holds junk or throws', () => {
    installLocalStorage(() => 'grid');
    expect(readQuotaViewMode()).toBe('ledger');
    installLocalStorage(() => {
      throw new Error('blocked');
    });
    expect(readQuotaViewMode()).toBe('ledger');
    delete (globalThis as { window?: unknown }).window;
    expect(readQuotaViewMode()).toBe('ledger');
    expect(() => writeQuotaViewMode('cards')).not.toThrow();
  });
});
