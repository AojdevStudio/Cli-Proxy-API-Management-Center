import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaLedger } from '@/features/quota/ledger/QuotaLedger';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import type { QuotaHistory } from '@/features/quota/history';
import { formatMonthDay, formatWeekdayTime } from '@/features/quota/ledger/ledgerModel';
import { timelineSpan } from '@/features/quota/quotaTimelineModel';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
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

/** Readings that burn each login at `rate` over the default 3h window. A null rate has no reading at its start. */
const historyBurning = (rates: Record<string, number | null>): QuotaHistory => ({
  provider: 'claude',
  range: '14d',
  fromMs: now - 14 * DAY_MS,
  toMs: now,
  logins: new Map(
    Object.entries(rates).map(([name, rate]) => [
      `fake-${name}`,
      {
        readings: [
          ...(rate === null
            ? []
            : [{ observedAtMs: now - 4 * HOUR_MS, usedPercent: 10, resetAtMs: now + DAY_MS }]),
          {
            observedAtMs: now - 30 * MINUTE_MS,
            usedPercent: 10 + 3 * (rate ?? 0),
            resetAtMs: now + DAY_MS,
          },
        ],
        gaps: [],
      },
    ])
  ),
});

const codexEntries = ['codex-1.json', 'codex-2.json'].map((name): QuotaFileEntry => ({
  file: { name, type: 'codex', authIndex: `fake-${name}` },
  type: 'codex',
}));

const codexQuota = (weeklyUsed: number): CodexQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'weekly',
      label: 'Weekly',
      usedPercent: weeklyUsed,
      resetLabel: '',
      resetAtMs: now + 3 * DAY_MS,
      periodHours: 168,
    },
  ],
});

const codexQuotas: Record<string, QuotaCardState> = {
  'codex-1.json': codexQuota(40),
  'codex-2.json': codexQuota(70),
};

const render = (
  page: readonly QuotaFileEntry[] = entries,
  history?: QuotaHistory,
  pool: readonly QuotaFileEntry[] = [...entries, disabledEntry]
) =>
  renderToStaticMarkup(
    createElement(QuotaLedger, {
      entries: page,
      poolEntries: pool,
      history: history ? { claude: history } : {},
      quotaFor: (entry: QuotaFileEntry) => quotas[entry.file.name] ?? codexQuotas[entry.file.name],
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
    expect(markup).toContain('Burn, last 3h');
    expect(markup).toContain('2.1%/h');
    expect(markup).toContain('Projected, Same as now');
  });

  test('keeps the current balance and reset schedule without an unsupported forecast', () => {
    const markup = render();
    expect(markup).toContain('128%');
    expect(markup).toContain('Next reset +69%');
    expect(markup).toContain('No forecast, insufficient history');
    const plot = markup.match(/<svg[^>]*viewBox="0 0 1000 200"[^>]*>([\s\S]*?)<\/svg>/)?.[1];
    expect(plot).toBeDefined();
    expect(plot).not.toContain('<path');
  });

  test('keeps a measured zero burn distinct from missing history', () => {
    const markup = render(
      entries,
      historyBurning({ 'claude-1.json': 0, 'claude-2.json': 0, 'claude-3.json': 0 })
    );
    expect(markup).toContain('0.0%/h');
    expect(markup).toContain('Projected, Same as now');
    expect(markup).not.toContain('No forecast, insufficient history');
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

  test('renders the shared controls with accessible names', () => {
    const markup = render();
    const span = timelineSpan('weekly', 0, now);
    expect(markup).toContain('role="toolbar" aria-label="Pool chart controls"');
    expect(markup).toContain('aria-label="Chart view"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Remaining</);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>3h</);
    expect(markup).toContain('Same as now');
    expect(markup).toContain(
      `${formatMonthDay(span.startMs, 'en')} to ${formatMonthDay(span.endMs - 1, 'en')}`
    );
    expect(markup).toContain('aria-label="Earlier week"');
    expect(markup).toContain('aria-label="Later week"');
    expect(markup).toMatch(/disabled=""[^>]*>Today</);
  });

  test('marks the empty point when the projected pool runs out inside the span', () => {
    const markup = render(
      entries,
      historyBurning({ 'claude-1.json': 10, 'claude-2.json': 10, 'claude-3.json': 10 })
    );
    const emptyMs = now + ((31 + 86 + 11) / 30) * HOUR_MS;
    expect(markup).toContain(`Empty ${formatWeekdayTime(emptyMs, 'en')}`);
    expect(markup).toMatch(/aria-hidden="true"><\/span>Empty</);
  });

  test('offers a Fable switch for Claude and none for Codex', () => {
    expect(render()).toContain('aria-label="Pool models"');
    expect(render()).toMatch(/aria-pressed="true"[^>]*>All models 128%</);
    expect(render()).toContain('Fable 173%');

    const codex = render(codexEntries, undefined, codexEntries);
    expect(codex).toContain('aria-label="Codex pool"');
    expect(codex).not.toContain('aria-label="Pool models"');
    expect(codex).not.toContain('Fable');
  });
});
