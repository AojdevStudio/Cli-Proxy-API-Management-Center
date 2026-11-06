/**
 * Panel-side inputs for the Usage page tests: auth files whose names and
 * fields carry emails, and quota states shaped like the 2026-11-06 readings.
 * Reader bodies live in tests/fixtures/usage-reader/ as byte copies of the
 * reader's own fixtures.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';

export const NOW = Date.parse('2026-11-06T19:38:00Z');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

export const readerFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, 'usage-reader', name), 'utf8'));

/** Account keys from overview-today.json breakdown.account. */
export const ACCOUNT_KEYS = {
  claudeBdb7: 'a0e07b30e1c8a023',
  claudeEca8: '90afbfd3e343bba6',
  claude9e6d: '3a454035e80467fe',
  codexB679: 'b4b17512bced5808',
  codex7614: 'd8ba33a863b67a31',
};

const file = (name: string, provider: string, authIndex: string, extra: Partial<AuthFileItem> = {}) =>
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
  file('claude-bravo@example.com.json', 'claude', ACCOUNT_KEYS.claudeEca8),
  file('claude-charlie@example.com.json', 'claude', ACCOUNT_KEYS.claude9e6d),
  file('codex-alpha@example.com.json', 'codex', ACCOUNT_KEYS.codexB679, {
    note: 'ossie.work@example.com main',
  }),
  file('codex-bravo@example.com.json', 'codex', ACCOUNT_KEYS.codex7614),
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
    { id: 'five-hour', label: '5h', usedPercent: fiveHour, resetLabel: '', resetAtMs: NOW - HOUR, periodHours: 5 },
    { id: 'seven-day', label: '7d', usedPercent: weekly, resetLabel: '', resetAtMs: NOW + resetH * HOUR, periodHours: 168 },
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
      : [{ id: 'five-hour', label: '5h', usedPercent: fiveHour, resetLabel: '', resetAtMs: NOW + 2 * HOUR, periodHours: 5 }]),
    { id: 'weekly', label: 'weekly', usedPercent: weekly, resetLabel: '', resetAtMs: NOW + resetH * HOUR, periodHours: 168 },
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
