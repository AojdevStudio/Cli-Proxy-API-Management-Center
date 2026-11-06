import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import i18n from '@/i18n';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { BRAND_COLORS, brandFor } from '@/features/usage/colors';
import {
  accountTokenMap,
  buildLoginRows,
  combineReader,
  dailyBars,
  failedSentence,
  hourlyBars,
  isLoginEntry,
  limitsBrief,
  limitsSentence,
  renderMessage,
  staleLine,
  tokensSentence,
  usageBrief,
  type Sentence,
} from '@/features/usage/logic';
import type { UsageOverview, UsageResult } from '@/features/usage/types';
import { usageApi } from '@/services/api/usage';
import {
  ACCOUNT_KEYS,
  AUTH_FILES,
  CLAUDE_QUOTA,
  CODEX_QUOTA,
  NOW,
  parsed,
} from './fixtures/usagePanel';

let today: UsageOverview;
let week: UsageOverview;
const t = i18n.t.bind(i18n);
const text = (s: Sentence) => s.parts.map((m) => renderMessage(t, m)).join(' ');

beforeAll(async () => {
  await i18n.changeLanguage('en');
  today = await parsed('overview-today.json', () => usageApi.overview('today'));
  week = await parsed('overview-7d.json', () => usageApi.overview('7d'));
});

const entries = classifyQuotaFiles(AUTH_FILES).filter(isLoginEntry);
const rows = () =>
  buildLoginRows(
    entries,
    { claude: CLAUDE_QUOTA, codex: CODEX_QUOTA },
    accountTokenMap(today),
    NOW
  );

describe('login rows', () => {
  test('tightest first, labelled without emails, joined to today by auth index', () => {
    const list = rows();
    expect(list.map((r) => [r.label, r.weekly?.usedPercent, r.read])).toEqual([
      ['claude max 2', 93, 'fresh'],
      ['main', 84, 'fresh'],
      ['codex team 3', 46, 'stale'],
      ['claude max 1', 12, 'fresh'],
      ['claude max 3', 2, 'fresh'],
      ['codex team 2', 1, 'stale'],
    ]);
    const byLabel = new Map(list.map((r) => [r.label, r.tokensToday]));
    expect(byLabel.get('claude max 1')).toBe(
      accountTokenMap(today).get(ACCOUNT_KEYS.claudeBdb7) ?? -1
    );
    expect(byLabel.get('codex team 3')).toBe(0);
    expect(list.some((r) => r.label.includes('@'))).toBe(false);
  });

  test('a failed read with nothing kept is marked failed, not hidden', () => {
    const list = buildLoginRows(
      entries,
      {
        claude: CLAUDE_QUOTA,
        codex: {
          ...CODEX_QUOTA,
          'codex-alpha@example.com.json': { status: 'error', windows: [], error: '401' },
        },
      },
      null,
      NOW
    );
    expect(list.find((r) => r.label === 'main')).toMatchObject({ read: 'failed', weekly: null });
  });

  test('a Claude login reloading keeps its last reading and still counts as current', () => {
    const reloading = {
      ...CLAUDE_QUOTA['claude-bravo@example.com.json'],
      status: 'loading' as const,
    };
    const list = buildLoginRows(
      entries,
      {
        claude: { ...CLAUDE_QUOTA, 'claude-bravo@example.com.json': reloading },
        codex: CODEX_QUOTA,
      },
      null,
      NOW
    );
    expect(list[0]).toMatchObject({ label: 'claude max 2', read: 'loading' });
    expect(limitsBrief(list)?.tightest.label).toBe('claude max 2');
  });
});

describe('sentence templates', () => {
  test('tightest login', () => {
    const sentence = limitsSentence(limitsBrief(rows()), NOW);
    expect(sentence.big).toBe('93%');
    expect(sentence.status?.tone).toBe('danger');
    expect(text(sentence)).toBe(
      'claude max 2 has used 93% of its weekly limit and resets in 3d 8h. main is next at 84%. The rest are at 12% or less.'
    );
  });

  test('no current reading says so instead of guessing', () => {
    const sentence = limitsSentence(limitsBrief([]), NOW);
    expect(sentence.big).toBeNull();
    expect(text(sentence)).toBe('No login has a fresh weekly reading yet.');
  });

  test('tokens against a normal day', () => {
    const sentence = tokensSentence(usageBrief(today), '13:38');
    expect(sentence.big).toBe('2.1B');
    expect(text(sentence)).toBe(
      'tokens went through the proxy today. That is 41% more than a normal day by 13:38 CT. 96% of them were cache reads, context the models read again.'
    );
    expect(text(tokensSentence(usageBrief({ ...today, baseline: null }), '13:38'))).toBe(
      'tokens went through the proxy today. There is no normal day to compare with yet. 96% of them were cache reads, context the models read again.'
    );
  });

  test('failed requests against the week', () => {
    const sentence = failedSentence(usageBrief(today), 'en');
    expect(sentence.big).toBe('89');
    expect(sentence.status).toBeNull();
    expect(text(sentence)).toBe(
      'requests failed today, 0.6% of 14,016. The week ran at 0.5%. gpt-6-luna had 60 of them.'
    );
  });

  test('stale readings get one quiet line', () => {
    expect(
      staleLine(rows(), NOW)
        .map((m) => renderMessage(t, m))
        .join(' ')
    ).toBe(
      'codex team 3 was last read 8h ago. codex team 2 was last read 3d ago. Those numbers may be old.'
    );
  });
});

describe('reader results', () => {
  const ready = <T>(data: T): UsageResult<T> => ({ status: 'ready', data });
  test('contract mismatch wins over warming and down', () => {
    const combined = combineReader({
      health: { status: 'warming', rowsLoaded: 10 },
      today: { status: 'offline', reason: { kind: 'reader-down' } },
      week: { status: 'offline', reason: { kind: 'contract-mismatch', got: 2 } },
      sessions: ready([]),
    });
    expect(combined).toEqual({ status: 'offline', reason: { kind: 'contract-mismatch', got: 2 } });
  });

  test('warming reports the most rows loaded', () => {
    expect(
      combineReader({
        health: { status: 'warming', rowsLoaded: 10 },
        today: { status: 'warming', rowsLoaded: 40 },
        week: ready(week),
        sessions: ready([]),
      })
    ).toEqual({ status: 'warming', rowsLoaded: 40 });
  });
});

describe('chart bars', () => {
  test('hourly bars mark the current CT hour, tick every 6 hours, and leave later hours empty', () => {
    const bars = hourlyBars(today, 'en');
    expect(bars).toHaveLength(24);
    expect(bars.findIndex((b) => b.state === 'now')).toBe(13);
    expect(bars.slice(14).every((b) => b.state === 'future')).toBe(true);
    expect(bars.flatMap((b) => (b.tick ? [b.tick] : []))).toEqual([
      '12 AM',
      '6 AM',
      '12 PM',
      '6 PM',
    ]);
    expect(bars.reduce((sum, b) => sum + b.total, 0)).toBe(
      today.series.groups.flatMap((g) => g.tokens).reduce((a, b) => a + b, 0)
    );
  });

  test('six-hour buckets fold into seven CT days across the DST change', () => {
    const days = dailyBars(week, 'en', 'Today');
    expect(days.map((d) => d.tick.split(' ')[0])).toEqual([
      'Sat',
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Today',
    ]);
    expect(days.at(-1)?.state).toBe('now');
    expect(days.reduce((sum, d) => sum + d.total, 0)).toBe(
      week.series.groups.flatMap((g) => g.tokens).reduce((a, b) => a + b, 0)
    );
  });
});

describe('colors', () => {
  const hex = (value: string) => value.match(/^#([0-9a-f]{6})$/i)?.[1] ?? '';
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color: string) => {
    const n = parseInt(hex(color), 16);
    return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hue = (color: string) => {
    const n = parseInt(hex(color), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => c / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  const blockAfter = (source: string, selector: string) =>
    source.slice(source.indexOf(selector)).split('\n}')[0];
  const token = (block: string, name: string) =>
    block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1] ?? 'missing';

  const themes = readFileSync('src/styles/themes.scss', 'utf8');
  const page = readFileSync('src/features/usage/UsagePage.module.scss', 'utf8');
  const backgrounds = (selector: string) =>
    ['--bg-primary', '--bg-secondary'].map((name) => token(blockAfter(themes, selector), name));
  const status = {
    light: blockAfter(page, '.page {'),
    dark: blockAfter(page, ":global([data-theme='dark']) .page {"),
  };

  test('status text passes WCAG AA on every theme background', () => {
    const surfaces = {
      light: [...backgrounds(':root'), ...backgrounds("[data-theme='white']")],
      dark: backgrounds("[data-theme='dark']"),
    };
    for (const mode of ['light', 'dark'] as const) {
      for (const bg of surfaces[mode]) {
        for (const tone of ['--usage-danger', '--usage-warn']) {
          const color = token(status[mode], tone);
          const pass = contrast(color, bg) >= 4.5;
          expect({ mode, tone, color, bg, pass }).toEqual({ mode, tone, color, bg, pass: true });
        }
      }
    }
  });

  test('status hues stay at least 45 degrees from the Claude brand hue', () => {
    const brandHue = hue(BRAND_COLORS.anthropic);
    for (const mode of ['light', 'dark'] as const) {
      for (const tone of ['--usage-danger', '--usage-warn']) {
        const gap = Math.abs(((hue(token(status[mode], tone)) - brandHue + 540) % 360) - 180);
        expect(gap).toBeGreaterThanOrEqual(45);
      }
    }
  });

  test('providers and models map to their brand', () => {
    expect(['claude', 'claude-opus-5-5', 'codex', 'gpt-6.1-sol', 'kimi-k3'].map(brandFor)).toEqual([
      'anthropic',
      'anthropic',
      'openai',
      'openai',
      'other',
    ]);
  });
});
