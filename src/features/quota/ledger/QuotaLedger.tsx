/**
 * Ledger view of the quota page: per provider, a ledger of its logins and a
 * pool card. Providers without a weekly pool stay on the card grid.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme } from '@/types';
import { TYPE_COLORS } from '@/utils/quota';
import type { QuotaFileEntry } from '../logic';
import type { QuotaHistory } from '../history';
import type { QuotaCardState } from '../providers';
import { POOL_MODELS, type PoolProvider } from '../pool';
import { timelineSpan } from '../quotaTimelineModel';
import { LEDGER_PROVIDERS, ledgerPool, toLedgerEntry, type LedgerEntry } from './ledgerModel';
import { LedgerPanel, type LedgerActions } from './LedgerPanel';
import { PoolCard, type CardPool } from './PoolCard';
import { PoolControlsBar } from './PoolControlsBar';
import { DEFAULT_POOL_CONTROLS, type PoolControls } from './poolControls';
import styles from './QuotaLedger.module.scss';

export interface QuotaLedgerProps extends LedgerActions {
  /** Ledger rows: the current page after tab and search. */
  entries: readonly QuotaFileEntry[];
  /** Every login on the file list. A pool sums its provider's enabled logins on any page. */
  poolEntries: readonly QuotaFileEntry[];
  history: Partial<Record<PoolProvider, QuotaHistory>>;
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  /** Injectable for tests and screenshots. Defaults to the shared minute clock. */
  now?: number;
}

export function QuotaLedger({
  entries,
  poolEntries,
  history,
  quotaFor,
  resolvedTheme,
  now: nowProp,
  ...actions
}: QuotaLedgerProps) {
  const tick = useNow(nowProp === undefined);
  const now = nowProp ?? tick;
  const [controls, setControls] = useState<PoolControls>(DEFAULT_POOL_CONTROLS);
  const span = useMemo(
    () => timelineSpan('weekly', controls.weekOffset, now),
    [controls.weekOffset, now]
  );

  const groups = useMemo(() => {
    const ledgersOf = (list: readonly QuotaFileEntry[]) =>
      list
        .map((entry) => toLedgerEntry(entry, quotaFor(entry)))
        .filter((ledger): ledger is LedgerEntry => ledger !== null);
    const rows = ledgersOf(entries);
    const pooled = ledgersOf(poolEntries);
    return LEDGER_PROVIDERS.map((provider) => {
      const members = pooled.filter((ledger) => ledger.provider === provider);
      const pools = POOL_MODELS[provider].map(({ model, windowId, recorded }) => ({
        model,
        recordedByReader: recorded,
        pool: ledgerPool(members, windowId, now),
      }));
      return {
        provider,
        ledgers: rows.filter((ledger) => ledger.provider === provider),
        pool: pools[0].pool,
        cardPools: pools.flatMap(({ pool, ...rest }): CardPool[] =>
          pool.nextReset ? [{ ...rest, pool, nextReset: pool.nextReset }] : []
        ),
      };
    }).filter((group) => group.ledgers.length > 0);
  }, [entries, poolEntries, quotaFor, now]);

  if (groups.length === 0) return null;

  return (
    <div className={styles.ledger}>
      {groups.some((group) => group.cardPools.length > 0) && (
        <PoolControlsBar
          controls={controls}
          onChange={(patch) => setControls((current) => ({ ...current, ...patch }))}
          span={span}
          now={now}
        />
      )}
      {groups.map(({ provider, ledgers, pool, cardPools }) => {
        const colors = TYPE_COLORS[provider];
        const accent = (resolvedTheme === 'dark' && colors.dark ? colors.dark : colors.light).text;
        return (
          <div
            key={provider}
            className={styles.group}
            style={{ '--ledger-accent': accent } as CSSProperties}
          >
            <LedgerPanel provider={provider} ledgers={ledgers} pool={pool} now={now} {...actions} />
            {cardPools.length > 0 && (
              <PoolCard
                provider={provider}
                pools={cardPools}
                history={history[provider] ?? null}
                controls={controls}
                span={span}
                now={now}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
