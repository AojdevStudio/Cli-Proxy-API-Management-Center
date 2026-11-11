import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaLedger } from '@/features/quota/ledger/QuotaLedger';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import type { ClaudeQuotaState } from '@/types';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const now = Date.now();

const claude = (name: string): QuotaFileEntry => ({
  file: { name, type: 'claude', auth_index: `fake-${name}` },
  type: 'claude',
});

const loaded = (weeklyUsed: number, fableUsed: number, resetInMs: number): ClaudeQuotaState => ({
  status: 'success',
  planType: 'plan_max20',
  observedAt: new Date(now - 2 * 60_000).toISOString(),
  windows: [
    {
      id: 'seven-day',
      label: '7-day limit',
      usedPercent: weeklyUsed,
      resetLabel: '',
      resetAtMs: now + resetInMs,
      periodHours: 168,
    },
    {
      id: 'seven-day-fable',
      label: '7-day Fable 5',
      usedPercent: fableUsed,
      resetLabel: '',
      resetAtMs: now + resetInMs,
      periodHours: 168,
    },
  ],
});

const entries = ['claude-1.json', 'claude-2.json', 'claude-3.json', 'claude-4.json'].map(claude);
const disabledEntry: QuotaFileEntry = {
  ...claude('claude-5.json'),
  file: { ...claude('claude-5.json').file, disabled: true },
};
const quotas: Record<string, QuotaCardState> = {
  'claude-1.json': loaded(69, 42, 19 * HOUR_MS),
  'claude-2.json': loaded(14, 9, 2 * DAY_MS + 10 * HOUR_MS),
  'claude-3.json': loaded(89, 76, 4 * DAY_MS + 20 * HOUR_MS),
  'claude-5.json': loaded(0, 0, DAY_MS),
};

const render = (page: readonly QuotaFileEntry[] = entries) =>
  renderToStaticMarkup(
    createElement(QuotaLedger, {
      entries: page,
      poolEntries: [...entries, disabledEntry],
      quotaFor: (entry: QuotaFileEntry) => quotas[entry.file.name],
      resolvedTheme: 'light',
      canUseActions: true,
      resettingQuotaName: null,
      onRefresh: () => {},
      onReset: () => {},
      now,
    })
  );

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('QuotaLedger', () => {
  test('heads the provider panel with the pool, its cap, and the next reset', () => {
    const markup = render();
    expect(markup).toContain('128%');
    expect(markup).toContain('of 300% pool');
    expect(markup).toContain('Next reset +69%');
    expect(markup).toContain('1 not loaded');
    expect(markup).toContain('aria-expanded="true"');
  });

  test('pools every enabled login of the provider while rows follow the page', () => {
    const markup = render(entries.slice(0, 1));
    expect(markup).toContain('of 300% pool');
    expect(markup).toContain('1 not loaded');
    expect(markup).toContain('aria-label="Refresh claude-1.json"');
    expect(markup).not.toContain('aria-label="Refresh claude-2.json"');
  });

  test('marks a weekly limit under 15% left as Low in words', () => {
    const markup = render();
    expect(markup).toContain('11% left');
    expect(markup).toMatch(/11% left<\/span><span[^>]*>Low<\/span>/);
    expect(markup).not.toMatch(/31% left<\/span><span[^>]*>Low/);
  });

  test('names every row action', () => {
    const markup = render();
    expect(markup).toContain('aria-label="Use a reset on claude-3.json"');
    expect(markup).toContain('aria-label="Refresh claude-1.json"');
    expect(markup).toContain('aria-label="Refresh claude-4.json"');
  });
});
