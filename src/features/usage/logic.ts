/**
 * Usage page pure logic: login rows, the headline brief behind both the three
 * sentences and the cards, chart bars, and messages. React-free, so
 * tests/usageLogic.test.ts drives it directly. Every text template lives in
 * i18n: functions here return keys and params.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';
import { stripEmails } from '@/services/api/usage';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { formatCompactNumber } from '@/utils/format';
import { resolveCodexPlanType } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { QuotaFileEntry } from '@/features/quota/logic';
import { brandFor, type BrandId, type StatusTone } from './colors';
import type { ReaderSnapshot, SessionList, SessionTurn, UsageOverview, UsageResult } from './types';

const READER_TIME_ZONE = 'America/Chicago';
/** A quota reading older than this is marked stale. */
const STALE_READ_MS = 2 * HOUR_MS;
/** The collector appends every 30 s. Five minutes of silence means it stopped. */
const COLLECTOR_QUIET_MS = 5 * MINUTE_MS;
const NEAR_LIMIT_PCT = 90;
const HIGH_PCT = 75;
export const SESSION_SPARK_COUNT = 8;

export interface Message {
  key: string;
  /** A param may itself be a message, such as a duration inside a sentence. */
  params?: Record<string, string | number | Message>;
}

/** Resolves a message, nested messages first. */
export function renderMessage(t: TFunction, message: Message): string {
  const params = Object.fromEntries(
    Object.entries(message.params ?? {}).map(([name, value]) => [
      name,
      typeof value === 'object' ? renderMessage(t, value) : value,
    ])
  );
  return t(message.key, params);
}

/* ---------- numbers and time ---------- */

export const compact = formatCompactNumber;

export const share = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0);

/** "3d 8h", "5h", "12m". */
export function durationMessage(ms: number): Message {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return { key: 'usage.units.minutes', params: { m: minutes } };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { key: 'usage.units.hours', params: { h: hours } };
  return { key: 'usage.units.days_hours', params: { d: Math.floor(hours / 24), h: hours % 24 } };
}

/** "just now", "12m ago", "8h ago", "3d ago". Minute precision, matching the page clock. */
export function agoMessage(ms: number): Message {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 1) return { key: 'usage.ago.just_now' };
  if (minutes < 90) return { key: 'usage.ago.minutes', params: { n: minutes } };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { key: 'usage.ago.hours', params: { n: hours } };
  return { key: 'usage.ago.days', params: { n: Math.round(hours / 24) } };
}

export const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** Clock time in the reader's day zone, "13:38". The CT suffix comes from i18n. */
export const clockCt = (ms: number, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: READER_TIME_ZONE,
  }).format(ms);

/** The reader's day for an instant, "2026-11-06". */
const ctDay = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: READER_TIME_ZONE }).format(ms);

const ctHour = (ms: number) =>
  Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: READER_TIME_ZONE,
    }).format(ms)
  );

/* ---------- reader results ---------- */

/**
 * Folds the four reader calls into one result. A contract mismatch wins, since
 * every other state is unreliable when the shapes disagree. Then offline, then
 * warming.
 */
export function combineReader(parts: {
  health: UsageResult<ReaderSnapshot['health']>;
  today: UsageResult<UsageOverview>;
  week: UsageResult<UsageOverview>;
  sessions: UsageResult<SessionList>;
}): UsageResult<ReaderSnapshot> {
  const { health, today, week, sessions } = parts;
  if (
    health.status === 'ready' &&
    today.status === 'ready' &&
    week.status === 'ready' &&
    sessions.status === 'ready'
  ) {
    return {
      status: 'ready',
      data: { health: health.data, today: today.data, week: week.data, ...sessions.data },
    };
  }
  const results = [health, today, week, sessions];
  const offline = results.flatMap((r) => (r.status === 'offline' ? [r] : []));
  const mismatch = offline.find((r) => r.reason.kind === 'contract-mismatch');
  if (mismatch) return mismatch;
  if (offline[0]) return offline[0];
  const warming = results.flatMap((r) => (r.status === 'warming' ? [r.rowsLoaded] : []));
  return { status: 'warming', rowsLoaded: Math.max(...warming) };
}

/* ---------- logins ---------- */

export type LoginProvider = 'claude' | 'codex';
export type LoginEntry = QuotaFileEntry & { type: LoginProvider };
export type ReadState = 'fresh' | 'stale' | 'failed' | 'loading' | 'unread';

export const isLoginEntry = (entry: QuotaFileEntry): entry is LoginEntry =>
  entry.type === 'claude' || entry.type === 'codex';

interface WindowReading {
  usedPercent: number;
  resetAtMs: number | null;
}

export type LimitPeriod = 'weekly' | 'monthly';
type LongReading = WindowReading & { period: LimitPeriod };

export interface LoginRow {
  key: string;
  provider: LoginProvider;
  brand: BrandId;
  label: string;
  /** The long limit: weekly, or monthly for a Codex Team login. */
  weekly: LongReading | null;
  fiveHour: WindowReading | null;
  read: ReadState;
  readAtMs: number | null;
  tokensToday: number | null;
}

type LoginQuota = ClaudeQuotaState | CodexQuotaState;

/** The long window per provider, in order of preference. Codex Team logins have a monthly one. */
const LONG_WINDOWS: Record<LoginProvider, [id: string, period: LimitPeriod][]> = {
  claude: [['seven-day', 'weekly']],
  codex: [
    ['weekly', 'weekly'],
    ['monthly', 'monthly'],
  ],
};

const readWindow = (quota: LoginQuota | undefined, id: string): WindowReading | null => {
  const window = quota?.windows.find((w) => w.id === id);
  if (!window || window.usedPercent === null) return null;
  return { usedPercent: window.usedPercent, resetAtMs: window.resetAtMs ?? null };
};

/** The quota store keeps `observedAt` as an ISO string. */
const parseIso = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Codex clears its windows while it reloads. Claude keeps the last reading
 * (useQuotaStore retains it), which is the "loading" state here.
 */
function readStateOf(quota: LoginQuota | undefined, now: number): ReadState {
  if (!quota || quota.status === 'idle') return 'unread';
  const hasReading = quota.windows.length > 0;
  if (quota.status === 'loading') return hasReading ? 'loading' : 'unread';
  if (quota.status === 'error') return hasReading ? 'stale' : 'failed';
  if ('stale' in quota && quota.stale === true) return 'stale';
  const readAt = parseIso(quota.observedAt);
  return readAt !== null && now - readAt > STALE_READ_MS ? 'stale' : 'fresh';
}

/** "plan_max20" -> "max", "pro" -> "pro". */
const planWord = (planType: string | null | undefined): string | null =>
  planType
    ?.toLowerCase()
    .replace(/^plan_/, '')
    .match(/^[a-z]+/)?.[0] ?? null;

/**
 * A login's display name. Never the file name or the email: a user-set note
 * (emails stripped) when there is one, else provider, plan, and an ordinal
 * that counts within the provider in file-name order, so it stays put when
 * the plan arrives later.
 */
function loginLabel(
  provider: LoginProvider,
  file: AuthFileItem,
  plan: string | null,
  ordinal: number
): string {
  const note = stripEmails(file.note ?? '');
  if (note) return note;
  return [provider, plan, String(ordinal)].filter(Boolean).join(' ');
}

/**
 * Joins quota readings, auth files, and today's per-account tokens into one
 * row per login, tightest weekly limit first, logins without a reading last.
 */
export function buildLoginRows(
  entries: LoginEntry[],
  quotaByKey: Record<LoginProvider, Record<string, LoginQuota>>,
  accountTokens: ReadonlyMap<string, number> | null,
  now: number
): LoginRow[] {
  const ordinals: Record<LoginProvider, number> = { claude: 0, codex: 0 };
  const rows = [...entries]
    .sort((a, b) => a.file.name.localeCompare(b.file.name))
    .map(({ file, type }): LoginRow => {
      const key = getQuotaCacheKey(file);
      const quota = quotaByKey[type][key];
      ordinals[type] += 1;
      const plan = planWord(
        quota?.planType ?? (type === 'codex' ? resolveCodexPlanType(file) : null)
      );
      const authIndex = normalizeAuthIndex(file.authIndex);
      const weekly =
        LONG_WINDOWS[type]
          .map(([id, period]) => {
            const reading = readWindow(quota, id);
            return reading && { ...reading, period };
          })
          .find((w) => w !== null) ?? null;
      const read = readStateOf(quota, now);
      // A reading whose reset has passed shows usage from before the reset.
      const preReset = weekly?.resetAtMs != null && weekly.resetAtMs <= now;
      return {
        key,
        provider: type,
        brand: brandFor(type),
        label: loginLabel(type, file, plan, ordinals[type]),
        weekly,
        fiveHour: readWindow(quota, 'five-hour'),
        read: preReset && (read === 'fresh' || read === 'loading') ? 'stale' : read,
        readAtMs: parseIso(quota?.observedAt),
        tokensToday:
          accountTokens && authIndex !== null ? (accountTokens.get(authIndex) ?? 0) : null,
      };
    });
  return rows.sort((a, b) => (b.weekly?.usedPercent ?? -1) - (a.weekly?.usedPercent ?? -1));
}

export const accountTokenMap = (today: UsageOverview): Map<string, number> =>
  new Map(today.breakdown.account.map((row) => [row.key, row.totals.tokens]));

export interface StatusMark {
  tone: StatusTone;
  word: Message;
}

export function limitStatus(percent: number): StatusMark | null {
  if (percent >= NEAR_LIMIT_PCT)
    return { tone: 'danger', word: { key: 'usage.status.near_limit' } };
  if (percent >= HIGH_PCT) return { tone: 'warn', word: { key: 'usage.status.high' } };
  return null;
}

export function readStatus(read: ReadState): StatusMark | null {
  if (read === 'stale') return { tone: 'warn', word: { key: 'usage.status.stale' } };
  if (read === 'failed') return { tone: 'danger', word: { key: 'usage.status.read_failed' } };
  return null;
}

/* ---------- the brief: one set of headline facts for sentences and cards ---------- */

export interface LimitsBrief {
  tightest: {
    label: string;
    brand: BrandId;
    pct: number;
    resetAtMs: number | null;
    period: LimitPeriod;
  };
  next: { label: string; pct: number } | null;
  restMax: number | null;
  status: StatusMark | null;
}

/** Tightest long limit among logins with a current reading. Null when none has one. */
export function limitsBrief(rows: LoginRow[]): LimitsBrief | null {
  const current = rows.flatMap((row) =>
    row.weekly && (row.read === 'fresh' || row.read === 'loading')
      ? [{ row, weekly: row.weekly }]
      : []
  );
  const [tightest, next, ...rest] = current;
  if (!tightest) return null;
  const pct = Math.round(tightest.weekly.usedPercent);
  return {
    tightest: {
      label: tightest.row.label,
      brand: tightest.row.brand,
      pct,
      resetAtMs: tightest.weekly.resetAtMs,
      period: tightest.weekly.period,
    },
    next: next ? { label: next.row.label, pct: Math.round(next.weekly.usedPercent) } : null,
    restMax:
      rest.length > 0 ? Math.round(Math.max(...rest.map((r) => r.weekly.usedPercent))) : null,
    status: limitStatus(pct),
  };
}

export interface UsageBrief {
  tokens: { total: number; deltaPct: number | null; cachePct: number | null };
  failed: {
    count: number;
    requests: number;
    ratePct: number;
    weekRatePct: number | null;
    worst: { label: string; count: number } | null;
    status: StatusMark | null;
  };
}

export function usageBrief(today: UsageOverview): UsageBrief {
  const total = today.totals.tokens;
  const avg = today.baseline?.tokensSameTimeAvg7d ?? null;
  const { failed, requests } = today.totals;
  const ratePct = share(failed, requests);
  const weekRate = today.baseline?.failRate7d ?? null;
  const weekRatePct = weekRate === null ? null : 100 * weekRate;
  const worst = today.breakdown.model.reduce<{ label: string; count: number } | null>(
    (best, row) =>
      row.totals.failed > (best?.count ?? 0)
        ? { label: row.label, count: row.totals.failed }
        : best,
    null
  );
  return {
    tokens: {
      total,
      deltaPct: avg !== null && avg > 0 ? Math.round(share(total - avg, avg)) : null,
      cachePct: total > 0 ? Math.round(share(today.totals.cacheRead, total)) : null,
    },
    failed: {
      count: failed,
      requests,
      ratePct,
      weekRatePct,
      worst,
      status:
        weekRatePct !== null && failed > 0 && ratePct > 2 * weekRatePct
          ? { tone: 'danger', word: { key: 'usage.status.above_normal' } }
          : null,
    },
  };
}

/* ---------- the three sentences ---------- */

export interface Sentence {
  /** The large number, formatted. Null renders as n/a. */
  big: string | null;
  status: StatusMark | null;
  parts: Message[];
}

export function limitsSentence(brief: LimitsBrief | null, now: number): Sentence {
  if (!brief) return { big: null, status: null, parts: [{ key: 'usage.sentence.limits_none' }] };
  const { tightest, next, restMax } = brief;
  const suffix = tightest.period === 'monthly' ? '_monthly' : '';
  const parts: Message[] = [
    tightest.resetAtMs !== null
      ? {
          key: `usage.sentence.limits_lead${suffix}`,
          params: {
            login: tightest.label,
            pct: tightest.pct,
            reset: durationMessage(tightest.resetAtMs - now),
          },
        }
      : {
          key: `usage.sentence.limits_lead_no_reset${suffix}`,
          params: { login: tightest.label, pct: tightest.pct },
        },
  ];
  if (next) {
    parts.push({ key: 'usage.sentence.limits_next', params: { login: next.label, pct: next.pct } });
  }
  if (restMax !== null) parts.push({ key: 'usage.sentence.limits_rest', params: { pct: restMax } });
  return { big: `${tightest.pct}%`, status: brief.status, parts };
}

export function tokensSentence(brief: UsageBrief, time: string): Sentence {
  const { total, deltaPct, cachePct } = brief.tokens;
  const parts: Message[] = [{ key: 'usage.sentence.tokens_lead' }];
  if (deltaPct === null) parts.push({ key: 'usage.sentence.tokens_no_baseline' });
  else if (deltaPct >= 0) {
    parts.push({ key: 'usage.sentence.tokens_more', params: { pct: deltaPct, time } });
  } else parts.push({ key: 'usage.sentence.tokens_less', params: { pct: -deltaPct, time } });
  if (cachePct !== null) {
    parts.push({ key: 'usage.sentence.tokens_cache', params: { pct: cachePct } });
  }
  return { big: compact(total), status: null, parts };
}

export function failedSentence(brief: UsageBrief, locale: string): Sentence {
  const { count, requests, ratePct, weekRatePct, worst, status } = brief.failed;
  const parts: Message[] = [
    {
      key: 'usage.sentence.failed_lead',
      params: { pct: ratePct.toFixed(1), requests: requests.toLocaleString(locale) },
    },
  ];
  if (weekRatePct !== null) {
    parts.push({ key: 'usage.sentence.failed_week', params: { pct: weekRatePct.toFixed(1) } });
  }
  if (worst) {
    parts.push({
      key: 'usage.sentence.failed_worst',
      params: { model: worst.label, count: worst.count.toLocaleString(locale) },
    });
  }
  return { big: count.toLocaleString(locale), status, parts };
}

/** The quiet line under the sentences: which login readings may be old. */
export function staleLine(rows: LoginRow[], now: number): Message[] {
  const items = rows.flatMap((row): Message[] => {
    if (row.read === 'failed') return [{ key: 'usage.stale.failed', params: { login: row.label } }];
    if (row.read !== 'stale') return [];
    if (row.readAtMs === null)
      return [{ key: 'usage.stale.unknown', params: { login: row.label } }];
    return [
      {
        key: 'usage.stale.item',
        params: { login: row.label, ago: agoMessage(now - row.readAtMs) },
      },
    ];
  });
  return items.length > 0 ? [...items, { key: 'usage.stale.tail' }] : [];
}

/* ---------- charts ---------- */

interface StackSegment {
  brand: BrandId;
  label: string;
  tokens: number;
}

export interface StackBar {
  /** Axis text under the bar, empty for unlabeled hours. */
  tick: string;
  tip: Message;
  total: number;
  segments: StackSegment[];
  state: 'past' | 'now' | 'future';
}

const segmentsAt = (overview: UsageOverview, index: number): StackSegment[] =>
  overview.series.groups.map((group) => ({
    brand: brandFor(group.key),
    label: group.label,
    tokens: group.tokens[index],
  }));

/** Today's hourly bars, a tick every 6 hours. The bucket holding `to` is "now". */
export function hourlyBars(today: UsageOverview, locale: string): StackBar[] {
  const hourLabel = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    timeZone: READER_TIME_ZONE,
  });
  const { buckets } = today.series;
  return buckets.map((start, i) => {
    const end = buckets[i + 1] ?? start + HOUR_MS;
    const total = today.series.bucketTokens[i];
    return {
      tick: ctHour(start) % 6 === 0 ? hourLabel.format(start) : '',
      tip: {
        key: 'usage.chart.bar_tip',
        params: { when: hourLabel.format(start), tokens: compact(total) },
      },
      total,
      segments: segmentsAt(today, i),
      state: start > today.to ? 'future' : today.to < end ? 'now' : 'past',
    };
  });
}

/** Sums 6-hour buckets into one bar per America/Chicago day, oldest first. */
export function dailyBars(week: UsageOverview, locale: string, todayName: string): StackBar[] {
  const days = new Map<string, { start: number; total: number; segments: StackSegment[] }>();
  week.series.buckets.forEach((start, i) => {
    const day = ctDay(start);
    const segments = segmentsAt(week, i);
    const total = week.series.bucketTokens[i];
    const prev = days.get(day);
    days.set(day, {
      start: prev?.start ?? start,
      total: (prev?.total ?? 0) + total,
      segments: prev
        ? prev.segments.map((s, j) => ({ ...s, tokens: s.tokens + segments[j].tokens }))
        : segments,
    });
  });
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    timeZone: READER_TIME_ZONE,
  });
  const todayKey = ctDay(week.to);
  return [...days.entries()].map(([day, { start, total, segments }]) => {
    const name = day === todayKey ? todayName : weekday.format(start);
    return {
      tick: `${name} ${compact(total)}`,
      tip: { key: 'usage.chart.bar_tip', params: { when: name, tokens: compact(total) } },
      total,
      segments,
      state: day === todayKey ? 'now' : 'past',
    };
  });
}

/** Polyline points for a context-per-turn sparkline in a width x height box. */
export function sparklinePoints(turns: SessionTurn[], width: number, height: number): string {
  const prompts = turns.map((t) => t.freshInput + t.cacheRead + t.cacheWrite);
  const max = Math.max(...prompts, 1);
  const step = prompts.length > 1 ? width / (prompts.length - 1) : 0;
  return prompts
    .map((p, i) => `${(i * step).toFixed(1)},${(height - 1 - ((height - 2) * p) / max).toFixed(1)}`)
    .join(' ');
}

/* ---------- reader notes ---------- */

export function readerNotes(snapshot: ReaderSnapshot, locale: string): Message[] {
  const { health, today, week } = snapshot;
  const notes: Message[] = [];
  if (health.collectorHeartbeatAt === null) notes.push({ key: 'usage.notes.collector_unknown' });
  const { oldestAt } = week.coverage;
  if (!week.coverage.rangeFullyCovered && oldestAt !== null) {
    notes.push({
      key: 'usage.notes.data_since',
      params: {
        date: new Intl.DateTimeFormat(locale, { timeZone: READER_TIME_ZONE }).format(oldestAt),
      },
    });
  }
  if (today.coverage.truncatedOldest || week.coverage.truncatedOldest) {
    notes.push({ key: 'usage.notes.truncated' });
  }
  const unparsed = Math.max(health.unparsedLines, today.coverage.unparsedLines);
  if (unparsed > 0) notes.push({ key: 'usage.notes.unparsed', params: { n: unparsed } });
  if (health.duplicateKeysDropped > 0) {
    notes.push({ key: 'usage.notes.duplicates', params: { n: health.duplicateKeysDropped } });
  }
  return notes;
}

/** How long since the collector last wrote, and whether that is too long. */
export function collectorAge(
  snapshot: ReaderSnapshot,
  now: number
): { ms: number; quiet: boolean } | null {
  const beat = snapshot.health.collectorHeartbeatAt;
  if (beat === null) return null;
  return { ms: now - beat, quiet: now - beat > COLLECTOR_QUIET_MS };
}
