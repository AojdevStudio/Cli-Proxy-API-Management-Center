import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { UsageView, type UsageViewProps } from '@/features/usage/UsageView';
import { accountTokenMap, buildLoginRows } from '@/features/usage/logic';
import type { ReaderSnapshot, SessionTurns, UsageResult } from '@/features/usage/types';
import { apiCallApi } from '@/services/api/apiCall';
import { usageApi } from '@/services/api/usage';
import { AUTH_FILES, CLAUDE_QUOTA, CODEX_QUOTA, NOW, readerFixture } from './fixtures/usagePanel';

const parsed = async <T>(name: string, call: () => Promise<UsageResult<T>>): Promise<T> => {
  const request = spyOn(apiCallApi, 'request').mockResolvedValue({
    statusCode: 200,
    header: {},
    bodyText: '',
    body: readerFixture(name),
  });
  try {
    const result = await call();
    if (result.status !== 'ready') throw new Error(`${name} did not parse`);
    return result.data;
  } finally {
    request.mockRestore();
  }
};

let snapshot: ReaderSnapshot;
let turns: SessionTurns;

beforeAll(async () => {
  await i18n.changeLanguage('en');
  snapshot = {
    health: await parsed('health.json', () => usageApi.health()),
    today: await parsed('overview-today.json', () => usageApi.overview('today')),
    week: await parsed('overview-7d.json', () => usageApi.overview('7d')),
    sessions: await parsed('sessions-today.json', () => usageApi.sessions('today')),
  };
  turns = await parsed('session-turns.json', () => usageApi.session('x'));
});

const render = (reader: UsageResult<ReaderSnapshot> | null) => {
  const props: UsageViewProps = {
    now: NOW,
    theme: 'light',
    logins: buildLoginRows(
      classifyQuotaFiles(AUTH_FILES),
      { claude: CLAUDE_QUOTA, codex: CODEX_QUOTA },
      reader?.status === 'ready' ? accountTokenMap(reader.data.today) : null,
      NOW
    ),
    loginsLoading: false,
    loginsError: '',
    reader,
    turns: new Map([[turns.session.id, { status: 'ready', data: turns }]]),
    refreshing: false,
    onRefresh: () => {},
    onSessionsOpen: () => {},
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

  test('reader down keeps login limits and names the job to check', () => {
    const { text } = render({ status: 'offline', reason: { kind: 'reader-down' } });
    expect(text).toContain('Usage reader is not running on the mini. Check the com.obi.cpa-usage-reader job');
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

  test('the shell keeps every route and gains only /usage', () => {
    const routes = readFileSync('src/router/MainRoutes.tsx', 'utf8');
    expect(routes).toContain("{ path: '/usage', element: <UsagePage /> }");
    const layout = readFileSync('src/components/layout/MainLayout.tsx', 'utf8');
    expect(layout).toContain("path: '/usage',");
  });
});
