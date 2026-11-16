import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import i18n from '@/i18n';
import { apiCallApi, type ApiCallResult } from '@/services/api/apiCall';
import { apiClient } from '@/services/api/client';
import { createClaudeAccountReads } from '@/services/api/claudeAccountReads';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import { readResetGrantsForCard } from '@/features/quota/providers/claude/resetGrantReads';
import { readClaudeResetGrants } from '@/services/api/claudeResetGrants';
import { useQuotaStore } from '@/stores/useQuotaStore';
import fixture from './fixtures/claude-oauth-usage.json';

const file = { name: 'claude-polling.json', type: 'claude', authIndex: 'polling-account' };
const usage = { ...fixture, cedar_ember: { eligible: false, grants: [] } };
const response = (body: unknown, statusCode = 200): ApiCallResult => ({
  statusCode,
  header: {},
  body,
  bodyText: JSON.stringify(body),
});
const originalRequest = apiCallApi.request;
let revision = 0;

beforeEach(() => {
  apiClient.setConfig({ apiBase: `http://quota-${++revision}.example`, managementKey: 'fixture' });
  useQuotaStore.getState().clearQuotaCache();
});

afterEach(() => {
  apiCallApi.request = originalRequest;
});

test('quota and reset displays share one full observation across refreshes', async () => {
  const calls: string[] = [];
  apiCallApi.request = async ({ url }) => {
    calls.push(url);
    return response(url.includes('/usage') ? usage : { account: { has_claude_max: true } });
  };
  const [quota, resets] = await Promise.all([
    CLAUDE_CONFIG.fetchQuota(file, i18n.t),
    readResetGrantsForCard(file.authIndex),
  ]);
  const refreshed = await CLAUDE_CONFIG.fetchQuota(file, i18n.t);
  await readResetGrantsForCard(file.authIndex);
  expect(calls.filter((url) => url.includes('/usage'))).toEqual([
    'https://api.anthropic.com/api/oauth/usage?cedar_ember=1',
  ]);
  expect(calls.filter((url) => url.endsWith('/profile'))).toHaveLength(1);
  expect(resets.eligible).toBe(false);
  expect(refreshed.observedAt).toBe(quota.observedAt);
  expect(refreshed.extraUsage).toEqual(quota.extraUsage);
});

test('quota, reset displays, and fresh preflights respect the same Retry-After', async () => {
  let now = Date.parse('2026-11-16T05:47:13Z');
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  let calls = 0;
  apiCallApi.request = async ({ url }) => {
    if (!url.includes('/usage')) return response({});
    calls += 1;
    return {
      ...response({ error: { message: 'Rate limited. Please try again later.' } }, 429),
      header: { 'Retry-After': ['900'] },
    };
  };
  try {
    await expect(CLAUDE_CONFIG.fetchQuota(file, i18n.t)).rejects.toThrow('429');
    now += 5 * 60 * 1000;
    await expect(readResetGrantsForCard(file.authIndex)).rejects.toThrow('rate_limited');
    await expect(readClaudeResetGrants(file.authIndex)).rejects.toThrow('rate_limited');
    await expect(CLAUDE_CONFIG.fetchQuota(file, i18n.t)).rejects.toThrow('429');
    expect(calls).toBe(1);
    now += 10 * 60 * 1000;
    await expect(CLAUDE_CONFIG.fetchQuota(file, i18n.t)).rejects.toThrow('429');
    expect(calls).toBe(2);
  } finally {
    clock.mockRestore();
  }
});

test('invalidating displayed values does not lift an upstream retry deadline', async () => {
  let calls = 0;
  apiCallApi.request = async ({ url }) => {
    if (!url.includes('/usage')) return response({});
    calls += 1;
    return { ...response({}, 429), header: { 'Retry-After': ['900'] } };
  };
  await expect(CLAUDE_CONFIG.fetchQuota(file, i18n.t)).rejects.toThrow('429');
  useQuotaStore.getState().clearQuotaCache([file.name]);
  await expect(CLAUDE_CONFIG.fetchQuota(file, i18n.t)).rejects.toThrow('429');
  expect(calls).toBe(1);
});

test.each([undefined, '0', 'invalid', 'Mon, 16 Nov 2026 06:02:13 GMT'])(
  'uses a bounded wait for Retry-After %s without blocking another account',
  async (retryAfter) => {
    let now = Date.parse('2026-11-16T05:47:13Z');
    const calls: string[] = [];
    const reader = createClaudeAccountReads({
      revision: () => 1,
      now: () => now,
      request: async ({ authIndex }) => {
        calls.push(authIndex!);
        return authIndex === 'other'
          ? response(usage)
          : { ...response({}, 429), header: retryAfter ? { 'retry-after': [retryAfter] } : {} };
      },
    });
    await reader.read('limited', 'usage');
    expect((await reader.read('other', 'usage')).response.statusCode).toBe(200);
    const wait = retryAfter?.endsWith('GMT') ? 15 * 60 * 1000 : 5 * 60 * 1000;
    now += wait - 1;
    await reader.read('limited', 'usage');
    expect(calls).toEqual(['limited', 'other']);
    now += 1;
    await reader.read('limited', 'usage');
    expect(calls).toEqual(['limited', 'other', 'limited']);
  }
);

test('reset-spending preflight reads fresh data instead of the displayed snapshot', async () => {
  let reads = 0;
  apiCallApi.request = async ({ url }) => {
    if (!url.includes('/usage')) return response({});
    reads += 1;
    return response({ ...usage, cedar_ember: { eligible: reads === 1, grants: [] } });
  };
  expect((await readResetGrantsForCard(file.authIndex)).eligible).toBe(true);
  expect((await readClaudeResetGrants(file.authIndex)).eligible).toBe(false);
  expect(reads).toBe(2);
});

test('a response from the previous connection cannot populate the new account cache', async () => {
  let revision = 1;
  let finish!: (result: ApiCallResult) => void;
  let calls = 0;
  const reader = createClaudeAccountReads({
    revision: () => revision,
    now: () => Date.now(),
    request: () => {
      calls += 1;
      return calls === 1
        ? new Promise<ApiCallResult>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(response(usage));
    },
  });
  const old = reader.read('a', 'usage').catch((error: unknown) => error);
  revision += 1;
  const fresh = await reader.read('a', 'usage');
  finish(response({ old: true }));
  expect(await old).toMatchObject({ message: 'Claude account observation invalidated' });
  expect(await reader.read('a', 'usage')).toBe(fresh);
  expect(calls).toBe(2);
});
