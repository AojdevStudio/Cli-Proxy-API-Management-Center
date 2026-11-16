import { beforeAll, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import {
  ClaudeReservationControl,
  ClaudeReservationStatus,
} from '@/features/quota/providers/claude/ClaudeReservationControl';
import type { ClaudeReservationState } from '@/features/quota/providers/claude/useClaudeReservation';
import { LedgerPanel } from '@/features/quota/ledger/LedgerPanel';
import type { LedgerEntry } from '@/features/quota/ledger/ledgerModel';
import { summarizePool } from '@/features/quota/pool';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const render = (state: ClaudeReservationState, disabled = false) =>
  renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(ClaudeReservationStatus, { state }),
      createElement(ClaudeReservationControl, {
        state,
        name: 'test account',
        disabled,
        onToggle: () => {},
        onRetry: () => {},
      })
    )
  );

test('reserve and full modes show their matching named actions', () => {
  const reserve = render({
    kind: 'ready',
    reservation: { fullAccess: false, reserveExcludedModels: [] },
  });
  expect(reserve).toContain('Reserve on');
  expect(reserve).toContain('aria-label="Use full account for test account"');
  expect(reserve).toContain('Use full account</span>');
  const full = render({
    kind: 'ready',
    reservation: { fullAccess: true, reserveExcludedModels: [] },
  });
  expect(full).toContain('Full account on');
  expect(full).toContain('aria-label="Restore reserve for test account"');
  expect(full).toContain('Restore reserve</span>');
});

test('pending changes disable the button and read failures offer a safe retry', () => {
  const pending = render({
    kind: 'saving',
    reservation: { fullAccess: false, reserveExcludedModels: [] },
  });
  expect(pending).toContain('disabled=""');
  expect(pending).toContain('aria-busy="true"');
  expect(pending).toContain('Saving');
  expect(render({ kind: 'error' })).toContain(
    'aria-label="Reload reserve status for test account"'
  );
  expect(render({ kind: 'unsupported' })).not.toContain('<button');
  expect(render({ kind: 'loading' })).not.toContain('<button');
  expect(
    render({ kind: 'ready', reservation: { fullAccess: false, reserveExcludedModels: [] } }, true)
  ).toContain('disabled=""');
});

test('all seven locales include every reservation label', async () => {
  const locales = await Promise.all(
    ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko', 'tr'].map(
      async (locale) =>
        (await Bun.file(`src/i18n/locales/${locale}.json`).json()).claude_reservation
    )
  );
  for (const locale of locales) {
    expect(Object.keys(locale).sort()).toEqual(Object.keys(locales[0]).sort());
    for (const value of Object.values(locale)) expect(typeof value).toBe('string');
    for (const key of ['use_full_label', 'restore_label', 'retry_label']) {
      expect(locale[key]).toContain('{{name}}');
    }
  }
});

test('the ledger places reservation status only on the approved Claude row', () => {
  const row = (name: string, provider: 'claude' | 'codex'): LedgerEntry => ({
    provider,
    entry: { file: { name, type: provider }, type: provider },
    quota: undefined,
  });
  const markup = renderToStaticMarkup(
    createElement(LedgerPanel, {
      provider: 'claude',
      ledgers: [row('claude-9ef827e2-test.json', 'claude'), row('claude-other.json', 'claude')],
      pool: summarizePool([], 2, 0),
      now: 0,
      canUseActions: true,
      resettingQuotaName: null,
      onRefresh: () => {},
      onReset: () => {},
    })
  );
  const rows = markup.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? [];
  expect(rows[1]).toContain('Loading reserve status');
  expect(rows[2]).not.toContain('reserve status');
});
