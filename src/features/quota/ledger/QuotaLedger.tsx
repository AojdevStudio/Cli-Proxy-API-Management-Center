/**
 * Ledger view of the quota page: per provider, a ledger of its logins and a
 * pool card. Providers without a weekly pool stay on the card grid.
 */

import { useMemo, type CSSProperties } from 'react';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme } from '@/types';
import { TYPE_COLORS } from '@/utils/quota';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import type { PoolHistoryPoint } from '../pool';
import { LEDGER_PROVIDERS, ledgerPool, toLedgerEntry, type LedgerEntry } from './ledgerModel';
import { LedgerPanel, type LedgerActions } from './LedgerPanel';
import { PoolCard } from './PoolCard';
import styles from './QuotaLedger.module.scss';

/** The panel records no quota history yet. The usage reader will serve it. */
const NO_HISTORY: readonly PoolHistoryPoint[] = [];

export interface QuotaLedgerProps extends LedgerActions {
  entries: readonly QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  /** Injectable for tests and screenshots. Defaults to the shared minute clock. */
  now?: number;
}

export function QuotaLedger({
  entries,
  quotaFor,
  resolvedTheme,
  now: nowProp,
  ...actions
}: QuotaLedgerProps) {
  const tick = useNow(nowProp === undefined);
  const now = nowProp ?? tick;

  const groups = useMemo(() => {
    const ledgers = entries
      .map((entry) => toLedgerEntry(entry, quotaFor(entry)))
      .filter((ledger): ledger is LedgerEntry => ledger !== null);
    return LEDGER_PROVIDERS.map((provider) => {
      const own = ledgers.filter((ledger) => ledger.provider === provider);
      return { provider, ledgers: own, pool: ledgerPool(own) };
    }).filter((group) => group.ledgers.length > 0);
  }, [entries, quotaFor]);

  if (groups.length === 0) return null;

  return (
    <div className={styles.ledger}>
      {groups.map(({ provider, ledgers, pool }) => {
        const colors = TYPE_COLORS[provider];
        const accent = (resolvedTheme === 'dark' && colors.dark ? colors.dark : colors.light).text;
        return (
          <div
            key={provider}
            className={styles.group}
            style={{ '--ledger-accent': accent } as CSSProperties}
          >
            <LedgerPanel provider={provider} ledgers={ledgers} pool={pool} now={now} {...actions} />
            {pool.nextReset && (
              <PoolCard
                provider={provider}
                pool={pool}
                nextReset={pool.nextReset}
                history={NO_HISTORY}
                burnPercentPerHour={null}
                now={now}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
