/**
 * Usage page pure logic: login rows, the three sentences, chart geometry, and
 * number formats. React-free, so tests/usageLogic.test.ts drives it directly.
 * Every text template lives in i18n. Functions here return keys and params.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';
import { stripEmails } from '@/services/api/usage';
import { resolveCodexPlanType } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '@/features/quota/logic';
import { brandFor, type BrandId, type StatusTone } from './colors';
import type {
  ReaderSnapshot,
  SessionTurn,
  Totals,
  UsageOverview,
  UsageResult,
} from './types';

export const READER_TIME_ZONE = 'America/Chicago';
/** A quota reading older than this is marked stale. */
export const STALE_READ_MS = 2 * 60 * 60 * 1000;
/** The collector appends every 30 s. Five minutes of silence means it stopped. */
export const COLLECTOR_QUIET_MS = 5 * 60 * 1000;
export const NEAR_LIMIT_PCT = 90;
export const HIGH_PCT = 75;
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

/* ---------- numbers ---------- */

export const tokensOf = (t: Pick<Totals, 'freshInput' | 'cacheRead' | 'cacheWrite' | 'output'>) =>
  t.freshInput + t.cacheRead + t.cacheWrite + t.output;

export const promptOf = (t: Pick<SessionTurn, 'freshInput' | 'cacheRead' | 'cacheWrite'>) =>
  t.freshInput + t.cacheRead + t.cacheWrite;

/** 2079488257 -> "2.08B", 162016318 -> "162M", 841555 -> "842K". */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e8) return `${Math.round(value / 1e6)}M`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

export const share = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0);

export const oneDecimal = (value: number) => value.toFixed(1);

/** "3d 8h", "5h", "12m". Returns a message so units translate. */
export function durationMessage(ms: number): Message {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return { key: 'usage.units.minutes', params: { m: minutes } };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { key: 'usage.units.hours', params: { h: hours } };
  return { key: 'usage.units.days_hours', params: { d: Math.floor(hours / 24), h: hours % 24 } };
}

/** "27s ago", "12m ago", "8h ago", "3d ago". */
export function agoMessage(ms: number): Message {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return { key: 'usage.ago.seconds', params: { n: seconds } };
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return { key: 'usage.ago.minutes', params: { n: minutes } };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { key: 'usage.ago.hours', params: { n: hours } };
  return { key: 'usage.ago.days', params: { n: Math.round(hours / 24) } };
}

export const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** Clock time in the reader's day zone, "13:38". The CT suffix comes from i18n. */
export const clockCt = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: READER_TIME_ZONE,
  }).format(new Date(iso));

const ctDateKey = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: READER_TIME_ZONE }).format(new Date(iso));

const ctHour = (iso: string) =>
  Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: READER_TIME_ZONE,
    }).format(new Date(iso))
  );

/* ---------- reader results ---------- */

/**
 * Folds the four reader calls into one result. A contract mismatch wins, since
 * every other state is unreliable when the shapes disagree. Then offline, then
 * warming, then ready.
 */
export function combineReader(parts: {
  health: UsageResult<ReaderSnapshot['health']>;
  today: UsageResult<UsageOverview>;
  week: UsageResult<UsageOverview>;
  sessions: UsageResult<ReaderSnapshot['sessions']>;
}): UsageResult<ReaderSnapshot> {
  const results = [parts.health, parts.today, parts.week, parts.sessions];
  const offline = results.flatMap((r) => (r.status === 'offline' ? [r] : []));
  const mismatch = offline.find((r) => r.reason.kind === 'contract-mismatch');
  if (mismatch) return mismatch;
  if (offline[0]) return offline[0];
  const warming = results.flatMap((r) => (r.status === 'warming' ? [r.rowsLoaded] : []));
  if (warming.length > 0) return { status: 'warming', rowsLoaded: Math.max(...warming) };
  const { health, today, week, sessions } = parts;
  if (
    health.status !== 'ready' ||
    today.status !== 'ready' ||
    week.status !== 'ready' ||
    sessions.status !== 'ready'
  ) {
    throw new Error('combineReader: unreachable, every non-ready result returned above');
  }
  return {
    status: 'ready',
    data: { health: health.data, today: today.data, week: week.data, sessions: sessions.data },
  };
}

/* ---------- logins ---------- */

export type LoginProvider = 'claude' | 'codex';
export type ReadState = 'fresh' | 'stale' | 'failed' | 'loading' | 'unread';

export interface WindowReading {
  usedPercent: number;
  resetAtMs: number | null;
}

export interface LoginRow {
  key: string;
  authIndex: string | null;
  provider: LoginProvider;
  brand: BrandId;
  label: string;
  weekly: WindowReading | null;
  fiveHour: WindowReading | null;
  read: ReadState;
  readAtMs: number | null;
  tokensToday: number | null;
}

export type LoginQuota = ClaudeQuotaState | CodexQuotaState;

const WEEKLY_WINDOW: Record<LoginProvider, string> = { claude: 'seven-day', codex: 'weekly' };
const FIVE_HOUR_WINDOW = 'five-hour';

const readWindow = (quota: LoginQuota | undefined, id: string): WindowReading | null => {
  const window = quota?.windows.find((w) => w.id === id);
  if (!window || window.usedPercent === null) return null;
  return { usedPercent: window.usedPercent, resetAtMs: window.resetAtMs ?? null };
};

const parseIso = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

function readStateOf(quota: LoginQuota | undefined, now: number): ReadState {
  if (!quota || quota.status === 'idle') return 'unread';
  const readAt = parseIso(quota.observedAt);
  const hasReading = quota.windows.length > 0;
  if (quota.status === 'loading') return hasReading ? 'loading' : 'unread';
  if (quota.status === 'error' && !hasReading) return 'failed';
  const markedStale = 'stale' in quota && quota.stale === true;
  if (markedStale || quota.status === 'error') return 'stale';
  return readAt !== null && now - readAt > STALE_READ_MS ? 'stale' : 'fresh';
}

/** "plan_max20" -> "max", "pro" -> "pro", "chatgptteam" stays as given. */
export function planWord(planType: string | null | undefined): string | null {
  if (!planType) return null;
  const word = planType
    .toLowerCase()
    .replace(/^plan_/, '')
    .match(/^[a-z]+/)?.[0];
  return word ?? null;
}

/**
 * A login's display name. Never the file name or the email: a user-set note
 * (emails stripped) when there is one, else provider, plan, and an ordinal
 * that counts within the provider in file-name order, so it stays put when
 * the plan arrives later.
 */
export function loginLabel(
  provider: LoginProvider,
  file: AuthFileItem,
  plan: string | null,
  ordinal: number
): string {
  const note = typeof file.note === 'string' ? stripEmails(file.note) : '';
  if (note) return note;
  return [provider, plan, String(ordinal)].filter(Boolean).join(' ');
}

const usageKeyOf = (file: AuthFileItem): string | null => {
  const raw = file.authIndex;
  if (raw === null || raw === undefined || raw === '') return null;
  return String(raw);
};

/**
 * Joins quota readings, auth files, and today's per-account tokens into one
 * row per login, tightest weekly limit first, logins without a reading last.
 */
export function buildLoginRows(
  entries: QuotaFileEntry[],
  quotaByKey: Record<LoginProvider, Record<string, LoginQuota>>,
  accountTokens: ReadonlyMap<string, number> | null,
  now: number
): LoginRow[] {
  const ordinals: Record<LoginProvider, number> = { claude: 0, codex: 0 };
  const logins = entries
    .flatMap((entry) =>
      entry.type === 'claude' || entry.type === 'codex' ? [{ ...entry, type: entry.type }] : []
    )
    .sort((a, b) => a.file.name.localeCompare(b.file.name));

  const rows = logins.map(({ file, type }): LoginRow => {
    const key = getQuotaCacheKey(file);
    const quota = quotaByKey[type][key];
    ordinals[type] += 1;
    const plan = planWord(
      quota?.planType ?? (type === 'codex' ? resolveCodexPlanType(file) : null)
    );
    const authIndex = usageKeyOf(file);
    return {
      key,
      authIndex,
      provider: type,
      brand: brandFor(type),
      label: loginLabel(type, file, plan, ordinals[type]),
      weekly: readWindow(quota, WEEKLY_WINDOW[type]),
      fiveHour: readWindow(quota, FIVE_HOUR_WINDOW),
      read: readStateOf(quota, now),
      readAtMs: parseIso(quota?.observedAt),
      tokensToday:
        accountTokens && authIndex !== null ? (accountTokens.get(authIndex) ?? 0) : null,
    };
  });

  return rows.sort(
    (a, b) => (b.weekly?.usedPercent ?? -1) - (a.weekly?.usedPercent ?? -1)
  );
}

export const accountTokenMap = (today: UsageOverview): Map<string, number> =>
  new Map(today.breakdown.account.map((row) => [row.key, tokensOf(row.totals)]));

/** A five-hour window whose reset is already past has rolled over to zero. */
export const fiveHourPercent = (reading: WindowReading, now: number): number =>
  reading.resetAtMs !== null && reading.resetAtMs <= now ? 0 : reading.usedPercent;

export interface StatusMark {
  tone: StatusTone;
  word: Message;
}

export function limitStatus(percent: number): StatusMark | null {
  if (percent >= NEAR_LIMIT_PCT) return { tone: 'danger', word: { key: 'usage.status.near_limit' } };
  if (percent >= HIGH_PCT) return { tone: 'warn', word: { key: 'usage.status.high' } };
  return null;
}

export function readStatus(read: ReadState): StatusMark | null {
  if (read === 'stale') return { tone: 'warn', word: { key: 'usage.status.stale' } };
  if (read === 'failed') return { tone: 'danger', word: { key: 'usage.status.read_failed' } };
  return null;
}

/* ---------- the three sentences ---------- */

export interface Sentence {
  /** The large number. Plain text, already formatted. */
  big: string;
  status: StatusMark | null;
  parts: Message[];
}

export function limitsSentence(rows: LoginRow[], now: number): Sentence {
  const fresh = rows.filter((row) => row.weekly && (row.read === 'fresh' || row.read === 'loading'));
  const [tightest, next, ...rest] = fresh;
  if (!tightest?.weekly) {
    return { big: 'n/a', status: null, parts: [{ key: 'usage.sentence.limits_none' }] };
  }
  const pct = Math.round(tightest.weekly.usedPercent);
  const parts: Message[] = [
    tightest.weekly.resetAtMs !== null
      ? {
          key: 'usage.sentence.limits_lead',
          params: {
            login: tightest.label,
            pct,
            reset: durationMessage(tightest.weekly.resetAtMs - now),
          },
        }
      : { key: 'usage.sentence.limits_lead_no_reset', params: { login: tightest.label, pct } },
  ];
  if (next?.weekly) {
    parts.push({
      key: 'usage.sentence.limits_next',
      params: { login: next.label, pct: Math.round(next.weekly.usedPercent) },
    });
  }
  if (rest.length > 0) {
    const restMax = Math.max(...rest.map((row) => row.weekly?.usedPercent ?? 0));
    parts.push({ key: 'usage.sentence.limits_rest', params: { pct: Math.round(restMax) } });
  }
  return { big: `${pct}%`, status: limitStatus(pct), parts };
}

export function tokensSentence(today: UsageOverview, locale: string): Sentence {
  const tokens = tokensOf(today.totals);
  const parts: Message[] = [{ key: 'usage.sentence.tokens_lead' }];
  const avg = today.baseline?.tokensSameTimeAvg7d ?? null;
  const time = clockCt(today.to, locale);
  if (avg !== null && avg > 0) {
    const delta = Math.round(share(tokens - avg, avg));
    parts.push(
      delta >= 0
        ? { key: 'usage.sentence.tokens_more', params: { pct: delta, time } }
        : { key: 'usage.sentence.tokens_less', params: { pct: -delta, time } }
    );
  } else {
    parts.push({ key: 'usage.sentence.tokens_no_baseline' });
  }
  if (tokens > 0) {
    parts.push({
      key: 'usage.sentence.tokens_cache',
      params: { pct: Math.round(share(today.totals.cacheRead, tokens)) },
    });
  }
  return { big: compact(tokens), status: null, parts };
}

export function failedSentence(today: UsageOverview, locale: string): Sentence {
  const { failed, requests } = today.totals;
  const rate = share(failed, requests);
  const weekRate = today.baseline?.failRate7d ?? null;
  const parts: Message[] = [
    {
      key: 'usage.sentence.failed_lead',
      params: { pct: oneDecimal(rate), requests: requests.toLocaleString(locale) },
    },
  ];
  if (weekRate !== null) {
    parts.push({ key: 'usage.sentence.failed_week', params: { pct: oneDecimal(100 * weekRate) } });
  }
  const worst = [...today.breakdown.model].sort((a, b) => b.totals.failed - a.totals.failed)[0];
  if (failed > 0 && worst && worst.totals.failed > 0) {
    parts.push({
      key: 'usage.sentence.failed_worst',
      params: { model: worst.label, count: worst.totals.failed.toLocaleString(locale) },
    });
  }
  const aboveNormal = weekRate !== null && failed > 0 && rate > 2 * 100 * weekRate;
  return {
    big: failed.toLocaleString(locale),
    status: aboveNormal ? { tone: 'danger', word: { key: 'usage.status.above_normal' } } : null,
    parts,
  };
}

/** The quiet line under the sentences: which login readings may be old. */
export function staleLine(rows: LoginRow[], now: number): Message[] {
  const items = rows.flatMap((row): Message[] => {
    if (row.read === 'failed') return [{ key: 'usage.stale.failed', params: { login: row.label } }];
    if (row.read !== 'stale') return [];
    if (row.readAtMs === null) return [{ key: 'usage.stale.unknown', params: { login: row.label } }];
    return [
      { key: 'usage.stale.item', params: { login: row.label, ago: agoMessage(now - row.readAtMs) } },
    ];
  });
  return items.length > 0 ? [...items, { key: 'usage.stale.tail' }] : [];
}

/* ---------- charts ---------- */

export interface StackSegment {
  brand: BrandId;
  label: string;
  tokens: number;
}

export interface StackBar {
  label: string;
  total: number;
  segments: StackSegment[];
  state: 'past' | 'now' | 'future';
}

const segmentsAt = (overview: UsageOverview, index: number): StackSegment[] =>
  overview.series.groups.map((group) => ({
    brand: brandFor(group.key),
    label: group.label,
    tokens: group.tokens[index] ?? 0,
  }));

/** Today's hourly bars. The bucket holding `to` is "now", later ones are empty. */
export function hourlyBars(today: UsageOverview): StackBar[] {
  const to = Date.parse(today.to);
  const starts = today.series.buckets.map((iso) => Date.parse(iso));
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? start + 60 * 60 * 1000;
    const segments = segmentsAt(today, i);
    return {
      label: String(ctHour(today.series.buckets[i])),
      total: segments.reduce((sum, s) => sum + s.tokens, 0),
      segments,
      state: start > to ? 'future' : to < end ? 'now' : 'past',
    };
  });
}

/** Sums 6-hour buckets into one bar per America/Chicago day. */
export function dailyBars(week: UsageOverview, todayKey: string): StackBar[] {
  const days = new Map<string, StackSegment[]>();
  week.series.buckets.forEach((iso, i) => {
    const day = ctDateKey(iso);
    const segments = segmentsAt(week, i);
    const prev = days.get(day);
    days.set(
      day,
      prev ? prev.map((s, j) => ({ ...s, tokens: s.tokens + segments[j].tokens })) : segments
    );
  });
  return [...days.entries()].map(([day, segments]) => ({
    label: day,
    total: segments.reduce((sum, s) => sum + s.tokens, 0),
    segments,
    state: day === todayKey ? 'now' : 'past',
  }));
}

export const ctDayOf = ctDateKey;

/** Polyline points for a context-per-turn sparkline in a width x height box. */
export function sparklinePoints(turns: SessionTurn[], width: number, height: number): string {
  const prompts = [...turns]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map(promptOf);
  if (prompts.length === 0) return '';
  const max = Math.max(...prompts, 1);
  const step = prompts.length > 1 ? width / (prompts.length - 1) : 0;
  return prompts
    .map((p, i) => `${(i * step).toFixed(1)},${(height - 1 - ((height - 2) * p) / max).toFixed(1)}`)
    .join(' ');
}

/* ---------- reader notes ---------- */

export function readerNotes(snapshot: ReaderSnapshot, locale: string): Message[] {
  const notes: Message[] = [];
  const beat = parseIso(snapshot.health.collectorHeartbeatAt);
  if (beat === null) notes.push({ key: 'usage.notes.collector_unknown' });
  const coverage = snapshot.today.coverage;
  if (!snapshot.week.coverage.rangeFullyCovered) {
    notes.push({
      key: 'usage.notes.data_since',
      params: { date: new Date(snapshot.week.coverage.oldestAt).toLocaleDateString(locale) },
    });
  }
  if (coverage.truncatedOldest || snapshot.week.coverage.truncatedOldest) {
    notes.push({ key: 'usage.notes.truncated' });
  }
  const unparsed = Math.max(snapshot.health.unparsedLines, coverage.unparsedLines);
  if (unparsed > 0) notes.push({ key: 'usage.notes.unparsed', params: { n: unparsed } });
  if (snapshot.health.duplicateKeysDropped > 0) {
    notes.push({ key: 'usage.notes.duplicates', params: { n: snapshot.health.duplicateKeysDropped } });
  }
  return notes;
}

export const collectorQuiet = (snapshot: ReaderSnapshot, now: number): boolean => {
  const beat = parseIso(snapshot.health.collectorHeartbeatAt);
  return beat !== null && now - beat > COLLECTOR_QUIET_MS;
};

export const collectorAgeMs = (snapshot: ReaderSnapshot, now: number): number | null => {
  const beat = parseIso(snapshot.health.collectorHeartbeatAt);
  return beat === null ? null : now - beat;
};
