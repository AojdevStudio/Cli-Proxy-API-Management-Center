import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaLedger } from '@/features/quota/ledger/QuotaLedger';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import type { QuotaHistory } from '@/features/quota/history';
import type { ClaudeQuotaState } from '@/types';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const now = Date.now();

const claude = (name: string): QuotaFileEntry => ({
  file: { name, type: 'claude', authIndex: `fake-${name}` },
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

const historyBurning = (rates: Record<string, number | null>): QuotaHistory => ({
  provider: 'claude',
  range: '7d',
  fromMs: now - 7 * DAY_MS,
  toMs: now,
  logins: new Map(
    Object.entries(rates).map(([name, rate]) => [
      `fake-${name}`,
      {
        readings: [{ observedAtMs: now - HOUR_MS, usedPercent: 10, resetAtMs: now + DAY_MS }],
        gaps: [],
        burn:
          rate === null
            ? { state: 'insufficient', reason: 'too_short' }
            : { state: 'measured', percentPerHour: rate, toMs: now - 5 * MINUTE_MS },
      },
    ])
  ),
});

const render = (page: readonly QuotaFileEntry[] = entries, history?: QuotaHistory) =>
  renderToStaticMarkup(
    createElement(QuotaLedger, {
      entries: page,
      poolEntries: [...entries, disabledEntry],
      history: history ? { claude: history } : {},
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

  test('sums measured burn over every pooled login, not only the rows on this page', () => {
    const markup = render(
      entries.slice(0, 1),
      historyBurning({ 'claude-1.json': 1.2, 'claude-2.json': 0.5, 'claude-3.json': 0.4 })
    );
    expect(markup).toContain('Burn, up to 6h');
    expect(markup).toContain('2.1%/h');
  });

  test('says the burn and the empty times are unknown while a pooled login lacks history', () => {
    for (const history of [
      undefined,
      historyBurning({ 'claude-1.json': 1.2, 'claude-2.json': 0.5 }),
      historyBurning({ 'claude-1.json': 1.2, 'claude-2.json': 0.5, 'claude-3.json': null }),
    ]) {
      const markup = render(entries, history);
      expect(markup).toContain('Not enough history');
      expect(markup).not.toContain('%/h');
      expect(markup).not.toContain('Not by');
      expect(markup).not.toContain('None before reset');
      expect(markup).toContain('Unknown, no burn rate');
    }
  });
});
