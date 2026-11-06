import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import i18n from '@/i18n';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { BRAND_COLORS, STATUS_COLORS, brandFor } from '@/features/usage/colors';
import {
  accountTokenMap,
  buildLoginRows,
  combineReader,
  compact,
  dailyBars,
  failedSentence,
  hourlyBars,
  limitsSentence,
  renderMessage,
  sparklinePoints,
  staleLine,
  tokensSentence,
  type Sentence,
} from '@/features/usage/logic';
import type { UsageOverview, UsageResult } from '@/features/usage/types';
import { usageApi } from '@/services/api/usage';
import { apiCallApi } from '@/services/api/apiCall';
import {
  ACCOUNT_KEYS,
  AUTH_FILES,
  CLAUDE_QUOTA,
  CODEX_QUOTA,
  NOW,
  readerFixture,
} from './fixtures/usagePanel';

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

let today: UsageOverview;
let week: UsageOverview;
const t = i18n.t.bind(i18n);
const text = (s: Sentence) => s.parts.map((m) => renderMessage(t, m)).join(' ');

beforeAll(async () => {
  await i18n.changeLanguage('en');
  today = await parsed('overview-today.json', () => usageApi.overview('today'));
  week = await parsed('overview-7d.json', () => usageApi.overview('7d'));
});

const rows = () =>
  buildLoginRows(
    classifyQuotaFiles(AUTH_FILES),
    { claude: CLAUDE_QUOTA, codex: CODEX_QUOTA },
    accountTokenMap(today),
    NOW
  );

describe('usage numbers', () => {
  test('compact formats match the mock', () => {
    expect([2079488257, 162016318, 51384211, 841555, 950].map(compact)).toEqual([
      '2.08B',
      '162M',
      '51.4M',
      '842K',
      '950',
    ]);
  });
});

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
      classifyQuotaFiles(AUTH_FILES),
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
});

describe('sentence templates', () => {
  test('tightest login', () => {
    const sentence = limitsSentence(rows(), NOW);
    expect(sentence.big).toBe('93%');
    expect(sentence.status?.tone).toBe('danger');
    expect(text(sentence)).toBe(
      'claude max 2 has used 93% of its weekly limit and resets in 3d 8h. main is next at 84%. The rest are at 12% or less.'
    );
  });

  test('tokens against a normal day', () => {
    const sentence = tokensSentence(today, 'en');
    expect(sentence.big).toBe('2.08B');
    expect(text(sentence)).toBe(
      'tokens went through the proxy today. That is 41% more than a normal day by 13:38 CT. 96% of them were cache reads, context the models read again.'
    );
    expect(text(tokensSentence({ ...today, baseline: null }, 'en'))).toBe(
      'tokens went through the proxy today. There is no normal day to compare with yet. 96% of them were cache reads, context the models read again.'
    );
  });

  test('failed requests against the week', () => {
    const sentence = failedSentence(today, 'en');
    expect(sentence.big).toBe('89');
    expect(sentence.status).toBeNull();
    expect(text(sentence)).toBe(
      'requests failed today, 0.6% of 14,016. The week ran at 0.5%. gpt-6-luna had 60 of them.'
    );
  });

  test('stale readings get one quiet line', () => {
    expect(staleLine(rows(), NOW).map((m) => renderMessage(t, m)).join(' ')).toBe(
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

describe('chart geometry', () => {
  test('hourly bars mark the current CT hour and leave later hours empty', () => {
    const bars = hourlyBars(today);
    expect(bars).toHaveLength(24);
    expect(bars.findIndex((b) => b.state === 'now')).toBe(13);
    expect(bars.slice(14).every((b) => b.state === 'future')).toBe(true);
    expect(bars.reduce((sum, b) => sum + b.total, 0)).toBe(
      today.series.groups.flatMap((g) => g.tokens).reduce((a, b) => a + b, 0)
    );
  });

  test('six-hour buckets fold into seven CT days across the DST change', () => {
    const days = dailyBars(week, '2026-11-06');
    expect(days.map((d) => d.label)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    expect(days.at(-1)?.state).toBe('now');
  });

  test('sparkline orders turns by event time and ends on the newest', () => {
    const turns = [
      { at: '2026-11-06T10:00:00Z', model: 'm', freshInput: 0, cacheRead: 200, cacheWrite: 0, output: 1, failed: false },
      { at: '2026-11-06T09:00:00Z', model: 'm', freshInput: 0, cacheRead: 100, cacheWrite: 0, output: 1, failed: false },
    ];
    expect(sparklinePoints(turns, 110, 20)).toBe('0.0,10.0 110.0,1.0');
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

  const themes = readFileSync('src/styles/themes.scss', 'utf8');
  const backgrounds = (selector: string) => {
    const block = themes.slice(themes.indexOf(selector)).split('\n}')[0];
    return ['--bg-primary', '--bg-secondary'].map(
      (token) => block.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1] ?? 'missing'
    );
  };

  test('status text passes WCAG AA on every theme background', () => {
    const surfaces = {
      light: [...backgrounds(':root'), ...backgrounds("[data-theme='white']")],
      dark: backgrounds("[data-theme='dark']"),
    };
    for (const mode of ['light', 'dark'] as const) {
      for (const bg of surfaces[mode]) {
        for (const tone of ['danger', 'warn'] as const) {
          const ratio = contrast(STATUS_COLORS[tone][mode], bg);
          expect({ mode, tone, bg, pass: ratio >= 4.5 }).toEqual({ mode, tone, bg, pass: true });
        }
      }
    }
  });

  test('status hues stay clear of the Claude brand hue', () => {
    const brandHue = hue(BRAND_COLORS.anthropic);
    for (const pair of Object.values(STATUS_COLORS)) {
      for (const color of Object.values(pair)) {
        const gap = Math.abs(((hue(color) - brandHue + 540) % 360) - 180);
        expect(gap).toBeGreaterThanOrEqual(45);
      }
    }
  });

  test('providers map to brands without logos or extra hues', () => {
    expect(['claude', 'claude-opus-5-5', 'codex', 'gpt-6.1-sol', 'kimi-k3'].map(brandFor)).toEqual([
      'anthropic',
      'anthropic',
      'openai',
      'openai',
      'other',
    ]);
  });
});

