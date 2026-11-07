/**
 * The Usage page body: three sentences, the logins-first split, and the folded
 * detail sections. Pure props in, markup out, so tests render it from fixtures.
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoginLimits } from './components/LoginLimits';
import { StatusWord, ToneText } from './components/marks';
import { TodayPanel } from './components/TodayPanel';
import { UsageFolds } from './components/UsageFolds';
import type { UsageData } from './hooks/useUsageData';
import {
  agoMessage,
  clockCt,
  collectorAge,
  failedSentence,
  limitsBrief,
  limitsSentence,
  readerNotes,
  renderMessage,
  staleLine,
  tokensSentence,
  usageBrief,
  type Message,
  type Sentence,
} from './logic';
import {
  READER_CONTRACT,
  type OfflineReason,
  type ReaderSnapshot,
  type UsageResult,
} from './types';
import styles from './UsagePage.module.scss';

const READER_JOB_LABEL = 'com.obi.cpa-usage-reader';

export function UsageView(props: UsageData) {
  const { t, i18n } = useTranslation();
  const msg = (m: Message) => renderMessage(t, m);
  const locale = i18n.language;
  const { now, logins, reader } = props;
  const snapshot = reader?.status === 'ready' ? reader.data : null;
  const time = snapshot ? clockCt(snapshot.today.to, locale) : '';
  const limits = limitsBrief(logins);
  const usage = snapshot ? usageBrief(snapshot.today) : null;

  const sentences: Sentence[] = [limitsSentence(limits, now)];
  if (usage) sentences.push(tokensSentence(usage, time), failedSentence(usage, locale));
  const stale = staleLine(logins, now);

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <h1 className={styles.title}>{t('usage.title')}</h1>
        <span className={styles.health}>
          {snapshot ? <HealthLine snapshot={snapshot} now={now} time={time} /> : null}
        </span>
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
              <ToneText mark={sentence.status}>{sentence.big ?? t('usage.na')}</ToneText>
              <StatusWord mark={sentence.status} />
            </span>
            <span className={styles.briefText}>{sentence.parts.map(msg).join(' ')}</span>
          </li>
        ))}
      </ol>
      {stale.length > 0 ? <p className={styles.quiet}>{stale.map(msg).join(' ')}</p> : null}

      <div className={styles.split}>
        <section className={styles.left} aria-labelledby="usage-logins">
          <LoginLimits
            logins={logins}
            brief={limits}
            loading={props.loginsLoading}
            error={props.loginsError}
            now={now}
          />
        </section>
        <section className={styles.right} aria-label={t('usage.today.title')}>
          {snapshot && usage ? (
            <TodayPanel
              today={snapshot.today}
              biggest={snapshot.sessions[0]}
              brief={usage}
              time={time}
              locale={locale}
            />
          ) : (
            <p className={styles.readerNote}>
              <ReaderState reader={reader} />
            </p>
          )}
        </section>
      </div>

      {snapshot ? (
        <>
          <UsageFolds
            snapshot={snapshot}
            turns={props.turns}
            time={time}
            locale={locale}
            onSessionsOpen={props.onSessionsOpen}
          />
          {readerNotes(snapshot, locale).map((note) => (
            <p key={note.key} className={styles.note}>
              {msg(note)}
            </p>
          ))}
        </>
      ) : null}
    </div>
  );
}

function HealthLine({
  snapshot,
  now,
  time,
}: {
  snapshot: ReaderSnapshot;
  now: number;
  time: string;
}) {
  const { t } = useTranslation();
  const age = collectorAge(snapshot, now);
  return (
    <>
      {age ? t('usage.header.collector', { ago: renderMessage(t, agoMessage(age.ms)) }) : null}{' '}
      {age?.quiet ? (
        <StatusWord mark={{ tone: 'warn', word: { key: 'usage.status.collector_quiet' } }} />
      ) : null}{' '}
      {t('usage.header.as_of', { time })}
    </>
  );
}

function offlineMessage(reason: OfflineReason): Message {
  switch (reason.kind) {
    case 'reader-down':
      return { key: 'usage.reader.down', params: { label: READER_JOB_LABEL } };
    case 'relay-refused':
      return { key: 'usage.reader.refused', params: { status: reason.status } };
    case 'reader-failed':
      return { key: 'usage.reader.failed', params: { detail: reason.detail } };
    case 'reader-error':
      return { key: 'usage.reader.error', params: { status: reason.status, error: reason.error } };
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
  const { t, i18n } = useTranslation();
  if (!reader) return <>{t('usage.reader.loading')}</>;
  if (reader.status === 'warming') {
    return (
      <>{t('usage.reader.warming', { rows: reader.rowsLoaded.toLocaleString(i18n.language) })}</>
    );
  }
  if (reader.status === 'offline') return <>{renderMessage(t, offlineMessage(reader.reason))}</>;
  return null;
}
