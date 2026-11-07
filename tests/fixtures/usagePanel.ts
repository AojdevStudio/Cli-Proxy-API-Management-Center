/**
 * Panel-side inputs for the Usage page tests: auth files whose names and
 * fields carry emails, and quota states shaped like the 2026-11-06 readings.
 * Reader bodies live in tests/fixtures/usage-reader/ as byte copies of the
 * reader's own fixtures.
 */

import { spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageResult } from '@/features/usage/types';
import { apiCallApi } from '@/services/api/apiCall';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';

export const NOW = Date.parse('2026-11-06T19:38:00Z');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

export const readerFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, 'usage-reader', name), 'utf8'));

/** Runs one usageApi call against a reader body served through the relay. */
export const parsedBody = async <T>(
  body: unknown,
  call: () => Promise<UsageResult<T>>
): Promise<T> => {
  const request = spyOn(apiCallApi, 'request').mockResolvedValue({
    statusCode: 200,
    header: {},
    bodyText: '',
    body,
  });
  try {
    const result = await call();
    if (result.status !== 'ready') throw new Error(`did not parse: ${JSON.stringify(result)}`);
    return result.data;
  } finally {
    request.mockRestore();
  }
};

/** Runs one usageApi call against a reader fixture served through the relay. */
export const parsed = <T>(name: string, call: () => Promise<UsageResult<T>>): Promise<T> =>
  parsedBody(readerFixture(name), call);

/**
 * Account keys are auth indexes. The first two appear in overview-today.json
 * breakdown.account. The rest have no usage today.
 */
export const ACCOUNT_KEYS = {
  claudeBdb7: 'bdb7a6482a60ce18',
  codexA1b2: 'a1b2c3d4e5f60718',
  claudeIdle1: 'f00dfacecafe0002',
  claudeIdle2: 'f00dfacecafe0003',
  codexIdle: 'f00dfacecafe0004',
};

const file = (
  name: string,
  provider: string,
  authIndex: string,
  extra: Partial<AuthFileItem> = {}
) =>
  ({
    name,
    type: provider,
    provider,
    email: name.replace(/^[a-z]+-/, '').replace(/\.json$/, ''),
    authIndex,
    ...extra,
  }) satisfies AuthFileItem;

export const AUTH_FILES: AuthFileItem[] = [
  file('claude-alpha@example.com.json', 'claude', ACCOUNT_KEYS.claudeBdb7),
  file('claude-bravo@example.com.json', 'claude', ACCOUNT_KEYS.claudeIdle1),
  file('claude-charlie@example.com.json', 'claude', ACCOUNT_KEYS.claudeIdle2),
  file('codex-alpha@example.com.json', 'codex', ACCOUNT_KEYS.codexA1b2, {
    note: 'ossie.work@example.com main',
  }),
  file('codex-bravo@example.com.json', 'codex', ACCOUNT_KEYS.codexIdle),
  file('codex-charlie@example.com.json', 'codex', 'f00dfacecafe0001'),
];

const claude = (
  weekly: number,
  resetH: number,
  fiveHour: number,
  observedMinAgo: number
): ClaudeQuotaState => ({
  status: 'success',
  planType: 'plan_max20',
  observedAt: new Date(NOW - observedMinAgo * MIN).toISOString(),
  stale: false,
  windows: [
    {
      id: 'five-hour',
      label: '5h',
      usedPercent: fiveHour,
      resetLabel: '',
      resetAtMs: NOW - HOUR,
      periodHours: 5,
    },
    {
      id: 'seven-day',
      label: '7d',
      usedPercent: weekly,
      resetLabel: '',
      resetAtMs: NOW + resetH * HOUR,
      periodHours: 168,
    },
  ],
});

const codex = (
  plan: string,
  weekly: number,
  resetH: number,
  fiveHour: number | null,
  observedMinAgo: number
): CodexQuotaState => ({
  status: 'success',
  planType: plan,
  observedAt: new Date(NOW - observedMinAgo * MIN).toISOString(),
  windows: [
    ...(fiveHour === null
      ? []
      : [
          {
            id: 'five-hour',
            label: '5h',
            usedPercent: fiveHour,
            resetLabel: '',
            resetAtMs: NOW + 2 * HOUR,
            periodHours: 5,
          },
        ]),
    {
      id: 'weekly',
      label: 'weekly',
      usedPercent: weekly,
      resetLabel: '',
      resetAtMs: NOW + resetH * HOUR,
      periodHours: 168,
    },
  ],
});

/** Keys follow getQuotaCacheKey, which is the file name for these files. */
export const CLAUDE_QUOTA: Record<string, ClaudeQuotaState> = {
  'claude-alpha@example.com.json': claude(12, 137.4, 1, 4),
  'claude-bravo@example.com.json': claude(93, 80.4, 1, 12),
  'claude-charlie@example.com.json': claude(2, 150.4, 19, 22),
};

export const CODEX_QUOTA: Record<string, CodexQuotaState> = {
  'codex-alpha@example.com.json': codex('pro', 84, 88, null, 4),
  'codex-bravo@example.com.json': codex('team', 1, 107.1, 5, 3649),
  'codex-charlie@example.com.json': codex('team', 46, 93.8, 5, 479),
};
