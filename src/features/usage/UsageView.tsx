/**
 * The Usage page body: three sentences, the logins-first split, and the folded
 * detail sections. Pure props in, markup out, so tests render it from fixtures.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { ResolvedTheme } from '@/types';
import { BRAND_COLORS, STATUS_COLORS, brandFor, type BrandId } from './colors';
import {
  agoMessage,
  collectorAgeMs,
  collectorQuiet,
  compact,
  clockCt,
  ctDayOf,
  dailyBars,
  durationMessage,
  failedSentence,
  fiveHourPercent,
  formatMs,
  hourlyBars,
  limitStatus,
  limitsSentence,
  readStatus,
  readerNotes,
  renderMessage,
  share,
  sparklinePoints,
  staleLine,
  tokensOf,
  tokensSentence,
  SESSION_SPARK_COUNT,
  type LoginRow,
  type Message,
  type Sentence,
  type StackBar,
  type StatusMark,
} from './logic';
import {
  READER_CONTRACT,
  type BreakdownRow,
  type OfflineReason,
  type ReaderSnapshot,
  type SessionTurns,
  type UsageOverview,
  type UsageResult,
} from './types';
import styles from './UsagePage.module.scss';

export interface UsageViewProps {
  now: number;
  theme: ResolvedTheme;
  logins: LoginRow[];
  loginsLoading: boolean;
  loginsError: string;
  reader: UsageResult<ReaderSnapshot> | null;
  turns: ReadonlyMap<string, UsageResult<SessionTurns>>;
  refreshing: boolean;
  onRefresh: () => void;
  onSessionsOpen: (ids: string[]) => void;
}

const READER_JOB_LABEL = 'com.obi.cpa-usage-reader';

const rootStyle = (theme: ResolvedTheme) =>
  ({
    '--usage-danger': STATUS_COLORS.danger[theme],
    '--usage-warn': STATUS_COLORS.warn[theme],
    '--usage-brand-anthropic': BRAND_COLORS.anthropic,
    '--usage-brand-openai': BRAND_COLORS.openai,
    '--usage-brand-other': BRAND_COLORS.other,
  }) as CSSProperties;

const brandVar = (brand: BrandId) => `var(--usage-brand-${brand})`;

export function UsageView(props: UsageViewProps) {
  const { t, i18n } = useTranslation();
  const msg = (m: Message) => renderMessage(t, m);
  const locale = i18n.language;
  const { now, logins, reader } = props;
  const snapshot = reader?.status === 'ready' ? reader.data : null;

  const sentences: Sentence[] = [limitsSentence(logins, now)];
  if (snapshot) {
    sentences.push(tokensSentence(snapshot.today, locale), failedSentence(snapshot.today, locale));
  }
  const stale = staleLine(logins, now);

  return (
    <div className={styles.page} style={rootStyle(props.theme)}>
      <div className={styles.top}>
        <h1 className={styles.title}>{t('usage.title')}</h1>
        <HealthLine snapshot={snapshot} now={now} locale={locale} />
        <Button
          variant="secondary"
          size="sm"
          className={styles.refresh}
          onClick={props.onRefresh}
          disabled={props.refreshing}
        >
          {props.refreshing ? t('usage.refreshing') : t('usage.refresh')}
        </Button>
      </div>

      <ol className={styles.brief}>
        {sentences.map((sentence, index) => (
          <li key={index} className={index === 0 ? styles.briefLead : undefined}>
            <span className={styles.briefNum}>
              <ToneText mark={sentence.status}>{sentence.big}</ToneText>
              <StatusWord mark={sentence.status} />
            </span>
            <span className={styles.briefText}>{sentence.parts.map(msg).join(' ')}</span>
          </li>
        ))}
      </ol>
      {stale.length > 0 ? <p className={styles.quiet}>{stale.map(msg).join(' ')}</p> : null}

      <div className={styles.split}>
        <section className={styles.left} aria-labelledby="usage-logins">
          <LoginLimits {...props} />
        </section>
        <section className={styles.right} aria-label={t('usage.today.title')}>
          {snapshot ? (
            <TodayPanel snapshot={snapshot} locale={locale} />
          ) : (
            <p className={styles.readerNote}>
              <ReaderState reader={reader} />
            </p>
          )}
        </section>
      </div>

      {snapshot ? (
        <Folds
          snapshot={snapshot}
          turns={props.turns}
          locale={locale}
          onSessionsOpen={props.onSessionsOpen}
        />
      ) : null}
      {snapshot
        ? readerNotes(snapshot, locale).map((note) => (
            <p key={note.key} className={styles.note}>
              {msg(note)}
            </p>
          ))
        : null}
    </div>
  );
}

const TONE_CLASS = { danger: styles.toneDanger, warn: styles.toneWarn } as const;

function ToneText({ mark, children }: { mark: StatusMark | null; children: ReactNode }) {
  return <span className={mark ? TONE_CLASS[mark.tone] : undefined}>{children}</span>;
}

function StatusWord({ mark }: { mark: StatusMark | null }) {
  const { t } = useTranslation();
  if (!mark) return null;
  return (
    <span className={`${styles.statusWord} ${TONE_CLASS[mark.tone]}`}>
      {renderMessage(t, mark.word)}
    </span>
  );
}

function HealthLine({
  snapshot,
  now,
  locale,
}: {
  snapshot: ReaderSnapshot | null;
  now: number;
  locale: string;
}) {
  const { t } = useTranslation();
  if (!snapshot) return <span className={styles.health} />;
  const age = collectorAgeMs(snapshot, now);
  return (
    <span className={styles.health}>
      {age !== null ? t('usage.header.collector', { ago: renderMessage(t, agoMessage(age)) }) : null}{' '}
      {collectorQuiet(snapshot, now) ? (
        <StatusWord mark={{ tone: 'warn', word: { key: 'usage.status.collector_quiet' } }} />
      ) : null}{' '}
      {t('usage.header.as_of', { time: clockCt(snapshot.today.to, locale) })}
    </span>
  );
}

function offlineMessage(reason: OfflineReason): Message {
  switch (reason.kind) {
    case 'reader-down':
      return { key: 'usage.reader.down', params: { label: READER_JOB_LABEL } };
    case 'relay-refused':
      return { key: 'usage.reader.refused', params: { status: reason.status } };
    case 'contract-mismatch':
      return {
        key: 'usage.reader.mismatch',
        params: { expected: READER_CONTRACT, got: String(reason.got ?? 'none') },
      };
    case 'bad-response':
      return { key: 'usage.reader.bad', params: { detail: reason.detail } };
  }
}

function ReaderState({ reader }: { reader: UsageResult<ReaderSnapshot> | null }) {
  const { t } = useTranslation();
  if (!reader) return <>{t('usage.reader.loading')}</>;
  if (reader.status === 'warming') {
    return <>{t('usage.reader.warming', { rows: reader.rowsLoaded.toLocaleString() })}</>;
  }
  if (reader.status === 'offline') return <>{renderMessage(t, offlineMessage(reader.reason))}</>;
  return null;
}

/* ---------- left: logins ---------- */

function LoginLimits({ logins, loginsLoading, loginsError, now }: UsageViewProps) {
  const { t } = useTranslation();
  const msg = (m: Message) => renderMessage(t, m);
  const tightest = logins.find((row) => row.weekly && row.read !== 'stale' && row.read !== 'failed');
  const next = tightest ? logins.find((row) => row !== tightest && row.weekly && row.read === 'fresh') : null;

  return (
    <>
      {tightest?.weekly ? (
        <div className={styles.stat}>
          <h2 className={styles.statLabel}>{t('usage.limits.tightest')}</h2>
          <div className={styles.statValueLarge}>
            <Swatch brand={tightest.brand} />
            <ToneText mark={limitStatus(tightest.weekly.usedPercent)}>
              {Math.round(tightest.weekly.usedPercent)}%
            </ToneText>
            <span className={styles.statSmall}>{tightest.label}</span>
            <StatusWord mark={limitStatus(tightest.weekly.usedPercent)} />
          </div>
          <p className={styles.statDetail}>
            {[
              tightest.weekly.resetAtMs !== null
                ? t('usage.limits.tightest_reset', {
                    reset: msg(durationMessage(tightest.weekly.resetAtMs - now)),
                  })
                : t('usage.limits.tightest_no_reset'),
              next?.weekly
                ? t('usage.limits.tightest_next', {
                    login: next.label,
                    pct: Math.round(next.weekly.usedPercent),
                  })
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
          </p>
        </div>
      ) : null}

      <h2 className={styles.sectionTitle} id="usage-logins">
        {t('usage.limits.title')}
      </h2>
      {loginsError ? (
        <p className={styles.readerNote}>{t('usage.limits.load_error', { error: loginsError })}</p>
      ) : logins.length === 0 ? (
        <p className={styles.readerNote}>
          {loginsLoading ? t('usage.limits.loading') : t('usage.limits.empty')}
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.limits.col_login')}</th>
                <th scope="col" className={styles.num}>
                  {t('usage.limits.col_weekly')}
                </th>
                <th scope="col" className={styles.meterCol}>
                  <span className={styles.srOnly}>{t('usage.limits.col_meter')}</span>
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.limits.col_resets')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.limits.col_five_hour')}
                </th>
                <th scope="col" className={`${styles.num} ${styles.hideSm}`}>
                  {t('usage.limits.col_today')}
                </th>
                <th scope="col" className={`${styles.num} ${styles.hideSm}`}>
                  {t('usage.limits.col_read')}
                </th>
              </tr>
            </thead>
            <tbody>
              {logins.map((row) => (
                <LoginTableRow key={row.key} row={row} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.note}>{t('usage.limits.source')}</p>
    </>
  );
}

function LoginTableRow({ row, now }: { row: LoginRow; now: number }) {
  const { t } = useTranslation();
  const msg = (m: Message) => renderMessage(t, m);
  const weekly = row.weekly;
  const weeklyMark = weekly ? limitStatus(weekly.usedPercent) : null;
  const readMark = readStatus(row.read);
  const readText =
    row.read === 'unread'
      ? t('usage.limits.unread')
      : row.read === 'failed'
        ? ''
        : row.readAtMs !== null
          ? msg(agoMessage(now - row.readAtMs))
          : t('usage.na');

  return (
    <tr>
      <th scope="row" className={styles.loginCell}>
        <Swatch brand={row.brand} />
        <span className={styles.loginLabel}>{row.label}</span>
        <StatusWord mark={readMark} />
      </th>
      <td className={styles.num}>
        {weekly ? (
          <>
            <ToneText mark={weeklyMark}>{Math.round(weekly.usedPercent)}%</ToneText>
            <StatusWord mark={weeklyMark} />
          </>
        ) : (
          t('usage.na')
        )}
      </td>
      <td className={styles.meterCol}>
        <div className={styles.meter} aria-hidden="true">
          {weekly ? (
            <i
              style={{
                width: `${Math.min(100, Math.max(0, weekly.usedPercent))}%`,
                background: brandVar(row.brand),
              }}
            />
          ) : null}
        </div>
      </td>
      <td className={styles.num}>
        {weekly?.resetAtMs != null ? msg(durationMessage(weekly.resetAtMs - now)) : t('usage.na')}
      </td>
      <td className={styles.num}>
        {row.fiveHour
          ? row.fiveHour.resetAtMs !== null && row.fiveHour.resetAtMs <= now
            ? t('usage.limits.reset_done')
            : `${Math.round(fiveHourPercent(row.fiveHour, now))}%`
          : t('usage.na')}
      </td>
      <td className={`${styles.num} ${styles.hideSm}`}>
        {row.tokensToday !== null ? compact(row.tokensToday) : t('usage.na')}
      </td>
      <td className={`${styles.num} ${styles.hideSm} ${styles.muted}`}>{readText}</td>
    </tr>
  );
}

function Swatch({ brand }: { brand: BrandId }) {
  return <span className={styles.swatch} style={{ background: brandVar(brand) }} aria-hidden="true" />;
}

/* ---------- right: today ---------- */

function TodayPanel({ snapshot, locale }: { snapshot: ReaderSnapshot; locale: string }) {
  const { t } = useTranslation();
  const { today, sessions } = snapshot;
  const tokens = tokensOf(today.totals);
  const avg = today.baseline?.tokensSameTimeAvg7d ?? null;
  const delta = avg ? Math.round(share(tokens - avg, avg)) : null;
  const time = clockCt(today.to, locale);
  const failed = failedSentence(today, locale);
  const big = sessions[0];
  const weekRate = today.baseline?.failRate7d ?? null;

  return (
    <>
      <div className={styles.stat}>
        <h2 className={styles.statLabel}>{t('usage.today.tokens')}</h2>
        <div className={styles.statValue}>
          {compact(tokens)}
          {delta !== null ? (
            <span className={styles.statSmall}>
              {delta >= 0 ? '+' : ''}
              {delta}%
            </span>
          ) : null}
        </div>
        <p className={styles.statDetail}>
          {[
            delta !== null
              ? t('usage.today.tokens_baseline', { time })
              : t('usage.sentence.tokens_no_baseline'),
            tokens > 0
              ? t('usage.today.tokens_cache', {
                  pct: Math.round(share(today.totals.cacheRead, tokens)),
                })
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
        </p>
      </div>

      <div className={styles.stat}>
        <h2 className={styles.statLabel}>{t('usage.today.failed')}</h2>
        <div className={styles.statValue}>
          <ToneText mark={failed.status}>{today.totals.failed.toLocaleString(locale)}</ToneText>
          <span className={styles.statSmall}>
            {share(today.totals.failed, today.totals.requests).toFixed(1)}%
          </span>
          <StatusWord mark={failed.status} />
        </div>
        <p className={styles.statDetail}>
          {[
            t('usage.today.failed_of', { requests: today.totals.requests.toLocaleString(locale) }),
            weekRate !== null
              ? t('usage.sentence.failed_week', { pct: (100 * weekRate).toFixed(1) })
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
        </p>
      </div>

      <div className={styles.stat}>
        <h2 className={styles.statLabel}>{t('usage.today.biggest')}</h2>
        {big ? (
          <>
            <div className={styles.statValue}>{compact(tokensOf(big.totals))}</div>
            <p className={styles.statDetail}>
              {t('usage.today.biggest_detail', {
                client: big.client,
                id: big.id.slice(0, 8),
                model: big.models.join(', ') || t('usage.na'),
                context: compact(big.lastPrompt),
              })}
            </p>
          </>
        ) : (
          <p className={styles.statDetail}>{t('usage.today.no_sessions')}</p>
        )}
      </div>

      <h2 className={styles.statLabel}>{t('usage.today.hourly')}</h2>
      <StackChart bars={hourlyBars(today)} kind="hours" overview={today} />
    </>
  );
}

function hourTick(hour: number): string {
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

function StackChart({
  bars,
  kind,
  overview,
  locale,
}: {
  bars: StackBar[];
  kind: 'hours' | 'days';
  overview: UsageOverview;
  locale?: string;
}) {
  const { t } = useTranslation();
  const max = Math.max(...bars.map((bar) => bar.total), 1);
  const brands = overview.series.groups.map((group) => ({ key: group.key, label: group.label }));
  const dayName = (key: string) =>
    new Date(`${key}T12:00:00`).toLocaleDateString(locale, { weekday: 'short' });

  return (
    <figure className={styles.chart}>
      <div className={kind === 'hours' ? styles.bars : styles.dayBars} role="img" aria-label={t(`usage.chart.${kind}_label`)}>
        {bars.map((bar, index) => (
          <div
            key={index}
            className={`${styles.bar} ${bar.state === 'future' ? styles.barFuture : ''} ${
              bar.state === 'now' ? styles.barNow : ''
            }`}
            title={
              kind === 'hours'
                ? t('usage.chart.hour_tip', { hour: bar.label, tokens: compact(bar.total) })
                : t('usage.chart.day_tip', { day: bar.label, tokens: compact(bar.total) })
            }
          >
            {bar.state === 'future'
              ? null
              : bar.segments.map((segment) => (
                  <i
                    key={segment.label}
                    style={{
                      height: `${(100 * segment.tokens) / max}%`,
                      background: brandVar(segment.brand),
                    }}
                  />
                ))}
          </div>
        ))}
      </div>
      <div className={kind === 'hours' ? styles.barTicks : styles.dayTicks} aria-hidden="true">
        {bars.map((bar, index) => (
          <span key={index}>
            {kind === 'hours'
              ? Number(bar.label) % 6 === 0
                ? hourTick(Number(bar.label))
                : ''
              : `${bar.state === 'now' ? t('usage.today_label') : dayName(bar.label)} ${compact(bar.total)}`}
          </span>
        ))}
      </div>
      <figcaption className={styles.legend}>
        {brands.map((brand) => (
          <span key={brand.key}>
            <span className={styles.swatch} style={{ background: brandVar(brandFor(brand.key)) }} />
            {brand.label}
          </span>
        ))}
        {kind === 'hours' ? <span>{t('usage.chart.now_note')}</span> : null}
      </figcaption>
    </figure>
  );
}

/* ---------- folded sections ---------- */

function Fold({
  title,
  meta,
  children,
  onOpen,
}: {
  title: string;
  meta: string;
  children: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <details
      className={styles.fold}
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen?.();
      }}
    >
      <summary>
        <span className={styles.foldTitle}>{title}</span>
        <span className={styles.foldMeta}>{meta}</span>
      </summary>
      <div className={styles.foldBody}>{children}</div>
    </details>
  );
}

function Folds({
  snapshot,
  turns,
  locale,
  onSessionsOpen,
}: {
  snapshot: ReaderSnapshot;
  turns: ReadonlyMap<string, UsageResult<SessionTurns>>;
  locale: string;
  onSessionsOpen: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const { today, week, sessions } = snapshot;
  const tokens = tokensOf(today.totals);
  const shown = sessions.slice(0, SESSION_SPARK_COUNT);
  const days = dailyBars(week, ctDayOf(today.to));
  const time = clockCt(today.to, locale);
  const p50 = today.totals.latencyMsP50;

  return (
    <div className={styles.folds}>
      <Fold
        title={t('usage.sections.sessions')}
        meta={t('usage.sections.sessions_meta', { n: sessions.length })}
        onOpen={() => onSessionsOpen(shown.map((s) => s.id))}
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.table.session')}</th>
                <th scope="col" className={styles.hideSm}>
                  {t('usage.table.model')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.table.tokens')}
                </th>
                <th scope="col" className={`${styles.num} ${styles.hideSm}`}>
                  {t('usage.table.turns')}
                </th>
                <th scope="col" className={styles.hideSm}>
                  {t('usage.table.active')}
                </th>
                <th scope="col">{t('usage.table.context')}</th>
                <th scope="col" className={styles.num}>
                  {t('usage.table.now')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((session) => {
                const result = turns.get(session.id);
                return (
                  <tr key={session.id}>
                    <th scope="row">
                      {session.client} {session.id.slice(0, 8)}
                    </th>
                    <td className={styles.hideSm}>{session.models.join(', ')}</td>
                    <td className={styles.num}>{compact(tokensOf(session.totals))}</td>
                    <td className={`${styles.num} ${styles.hideSm}`}>
                      {session.turns.toLocaleString(locale)}
                    </td>
                    <td className={styles.hideSm}>
                      {t('usage.table.time_range', {
                        from: clockCt(session.firstAt, locale),
                        to: clockCt(session.lastAt, locale),
                      })}
                    </td>
                    <td>
                      {result?.status === 'ready' ? (
                        <svg
                          className={styles.spark}
                          viewBox="0 0 110 20"
                          role="img"
                          aria-label={t('usage.table.context_label', {
                            peak: compact(session.peakPrompt),
                          })}
                        >
                          <polyline points={sparklinePoints(result.data.turns, 110, 20)} />
                        </svg>
                      ) : (
                        <span className={styles.muted}>
                          {result ? t('usage.na') : t('usage.table.context_loading')}
                        </span>
                      )}
                    </td>
                    <td className={styles.num}>{compact(session.lastPrompt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={styles.note}>{t('usage.table.context_note')}</p>
      </Fold>

      <Fold
        title={t('usage.sections.days')}
        meta={t('usage.sections.days_meta', { tokens: compact(tokensOf(week.totals)) })}
      >
        <StackChart bars={days} kind="days" overview={week} locale={locale} />
        <p className={styles.note}>{t('usage.days_note', { time })}</p>
      </Fold>

      <Fold
        title={t('usage.sections.models')}
        meta={t('usage.sections.count_meta', { n: today.breakdown.model.length })}
      >
        <BreakdownTable rows={today.breakdown.model} total={tokens} heading={t('usage.table.model')} locale={locale} />
      </Fold>

      <Fold
        title={t('usage.sections.clients')}
        meta={t('usage.sections.count_meta', { n: today.breakdown.client.length })}
      >
        <BreakdownTable rows={today.breakdown.client} total={tokens} heading={t('usage.table.client')} locale={locale} />
      </Fold>

      <Fold
        title={t('usage.sections.speed')}
        meta={p50 !== null ? t('usage.sections.speed_meta', { ms: formatMs(p50) }) : t('usage.na')}
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.table.model')}</th>
                <th scope="col" className={styles.num}>
                  {t('usage.table.median')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.table.requests')}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{t('usage.speed.all')}</th>
                <td className={styles.num}>{p50 !== null ? formatMs(p50) : t('usage.na')}</td>
                <td className={styles.num}>{today.totals.requests.toLocaleString(locale)}</td>
              </tr>
              {today.breakdown.model.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td className={styles.num}>
                    {row.totals.latencyMsP50 !== null ? formatMs(row.totals.latencyMsP50) : t('usage.na')}
                  </td>
                  <td className={styles.num}>{row.totals.requests.toLocaleString(locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.note}>{t('usage.speed.note')}</p>
      </Fold>

      <Fold
        title={t('usage.sections.mix')}
        meta={t('usage.sections.mix_meta', { pct: Math.round(share(today.totals.cacheRead, tokens)) })}
      >
        <TokenMix today={today} />
      </Fold>
    </div>
  );
}

function BreakdownTable({
  rows,
  total,
  heading,
  locale,
}: {
  rows: BreakdownRow[];
  total: number;
  heading: string;
  locale: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{heading}</th>
            <th scope="col" className={styles.num}>
              {t('usage.table.tokens')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.table.share')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.table.requests')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.table.failed')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={styles.loginCell}>
                <Swatch brand={brandFor(row.key)} />
                <span className={styles.loginLabel}>{row.label}</span>
              </th>
              <td className={styles.num}>{compact(tokensOf(row.totals))}</td>
              <td className={styles.num}>{share(tokensOf(row.totals), total).toFixed(1)}%</td>
              <td className={styles.num}>{row.totals.requests.toLocaleString(locale)}</td>
              <td className={styles.num}>{row.totals.failed.toLocaleString(locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TokenMix({ today }: { today: UsageOverview }) {
  const { t } = useTranslation();
  const tokens = tokensOf(today.totals);
  const { reasoning } = today.totals;
  const rows: [string, number | null, string?][] = [
    [t('usage.mix.cache_read'), today.totals.cacheRead],
    [t('usage.mix.fresh'), today.totals.freshInput],
    [t('usage.mix.cache_write'), today.totals.cacheWrite],
    [t('usage.mix.output'), today.totals.output],
    [
      t('usage.mix.reasoning'),
      reasoning.rowsReporting > 0 ? reasoning.sum : null,
      reasoning.rowsReporting > 0 && reasoning.rowsReporting < today.totals.requests
        ? t('usage.partial', {
            pct: Math.round(share(reasoning.rowsReporting, today.totals.requests)),
          })
        : undefined,
    ],
  ];
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('usage.table.kind')}</th>
            <th scope="col" className={styles.num}>
              {t('usage.table.tokens')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.table.share')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value, note]) => (
            <tr key={name}>
              <th scope="row">
                {name}
                {note ? <span className={styles.muted}> {note}</span> : null}
              </th>
              <td className={styles.num}>{value !== null ? compact(value) : t('usage.na')}</td>
              <td className={styles.num}>
                {value !== null ? `${share(value, tokens).toFixed(1)}%` : t('usage.na')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
