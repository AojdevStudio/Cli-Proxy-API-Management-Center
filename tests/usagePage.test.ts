import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { UsageView } from '@/features/usage/UsageView';
import type { UsageData } from '@/features/usage/hooks/useUsageData';
import { accountTokenMap, buildLoginRows, isLoginEntry } from '@/features/usage/logic';
import type { ReaderSnapshot, SessionTurn, UsageResult } from '@/features/usage/types';
import { usageApi } from '@/services/api/usage';
import { AUTH_FILES, CLAUDE_QUOTA, CODEX_QUOTA, NOW, parsed } from './fixtures/usagePanel';

let snapshot: ReaderSnapshot;
let turns: SessionTurn[];

beforeAll(async () => {
  await i18n.changeLanguage('en');
  snapshot = {
    health: await parsed('health.json', () => usageApi.health()),
    today: await parsed('overview-today.json', () => usageApi.overview('today')),
    week: await parsed('overview-7d.json', () => usageApi.overview('7d')),
    ...(await parsed('sessions-today.json', () => usageApi.sessions('today'))),
  };
  turns = await parsed('session-turns.json', () => usageApi.sessionTurns('x'));
});

const render = (reader: UsageResult<ReaderSnapshot> | null, overrides: Partial<UsageData> = {}) => {
  const props: UsageData = {
    now: NOW,
    logins: buildLoginRows(
      classifyQuotaFiles(AUTH_FILES).filter(isLoginEntry),
      { claude: CLAUDE_QUOTA, codex: CODEX_QUOTA },
      reader?.status === 'ready' ? accountTokenMap(reader.data.today) : null,
      NOW
    ),
    loginsLoading: false,
    loginsError: '',
    reader,
    turns: new Map([[snapshot.sessions[0].id, { status: 'ready', data: turns }]]),
    refreshing: false,
    onRefresh: () => {},
    onSessionsOpen: () => {},
    ...overrides,
  };
  const markup = renderToStaticMarkup(createElement(UsageView, props));
  return { markup, text: markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
};

describe('Usage page', () => {
  test('renders from fixtures with no email anywhere, though auth files carry them', () => {
    const { markup, text } = render({ status: 'ready', data: snapshot });
    expect(AUTH_FILES.every((file) => file.name.includes('@'))).toBe(true);
    expect(text).toContain('claude max 2 has used 93% of its weekly limit');
    expect(text).toContain('Biggest session');
    expect(text).toContain('Token mix');
    expect(markup).toContain('<polyline');
    expect(markup.includes('@')).toBe(false);
  });

  test('totals on screen are the reader totals, and sessions show their own id', () => {
    const { text } = render({ status: 'ready', data: snapshot });
    expect(text).toContain('Tokens today 236K');
    expect(text).toContain('Last 7 days 249K tokens');
    expect(text).toContain('Sessions 3 today');
    expect(text).toContain('claude-code aaaaaaaa, claude-opus-5-5. Context now 27K.');
    expect(text).toContain('codex aaaaaaaa');
    expect(text).not.toContain('claude-c ');
    const many = render({ status: 'ready', data: { ...snapshot, sessionCount: 5518 } });
    expect(many.text).toContain('Sessions 5,518 today');
  });

  test('a reader that cannot sync its logs says why and keeps login limits', () => {
    const { text } = render({
      status: 'offline',
      reason: { kind: 'reader-failed', detail: 'EACCES: usage dir' },
    });
    expect(text).toContain('The usage reader could not read its logs: EACCES: usage dir.');
    expect(text).toContain('claude max 2 has used 93%');
  });

  test('a login list error that quotes a file name shows no email', () => {
    const { text } = render(
      { status: 'ready', data: snapshot },
      { logins: [], loginsError: 'cannot read codex-review@example.com.json' }
    );
    expect(text).toContain('Could not load the login list: cannot read From');
    expect(text.includes('@')).toBe(false);
  });

  test('reader down keeps login limits and names the job to check', () => {
    const { text } = render({ status: 'offline', reason: { kind: 'reader-down' } });
    expect(text).toContain(
      'Usage reader is not running on the mini. Check the com.obi.cpa-usage-reader job'
    );
    expect(text).toContain('claude max 2 has used 93%');
    expect(text).toContain('codex team 3');
    expect(text).not.toContain('Biggest session');
    expect(text.includes('@')).toBe(false);
  });

  test('warming, contract mismatch, and first load each say what is happening', () => {
    expect(render({ status: 'warming', rowsLoaded: 1200 }).text).toContain(
      'Loading usage history, 1,200 rows so far.'
    );
    expect(
      render({ status: 'offline', reason: { kind: 'contract-mismatch', got: 2 } }).text
    ).toContain('The panel expects 1, the reader sent 2.');
    expect(render(null).text).toContain('Loading usage numbers.');
  });

  test('n/a fields render as n/a, not zero', () => {
    const bare = structuredClone(snapshot);
    bare.today.totals.reasoning = { sum: 0, rowsReporting: 0 };
    bare.today.totals.latencyMsP50 = null;
    const { text } = render({ status: 'ready', data: bare });
    expect(text).toContain('Reasoning (inside output) n/a n/a');
    expect(text).toContain('Speed n/a');
  });

  test('registers /usage in the router and the sidebar', () => {
    const routes = readFileSync('src/router/MainRoutes.tsx', 'utf8');
    expect(routes).toContain("{ path: '/usage', element: <UsagePage /> }");
    const layout = readFileSync('src/components/layout/MainLayout.tsx', 'utf8');
    expect(layout).toContain("path: '/usage',");
  });
});
