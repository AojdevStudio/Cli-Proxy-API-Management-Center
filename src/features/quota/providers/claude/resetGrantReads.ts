import { apiClient } from '@/services/api/client';
import {
  readClaudeResetGrants,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';

export const RESET_GRANT_READ_DELAY_MS = 2000;

/** One delayed attempt per effect activation, never an automatic retry. */
export function scheduleResetGrantRead(start: () => void, current: () => boolean) {
  const timeout = setTimeout(() => {
    if (current()) start();
  }, RESET_GRANT_READ_DELAY_MS);
  return () => clearTimeout(timeout);
}

/** Only card reads are shared. Spending still performs its own fresh preflight reads. */
export function createResetGrantReader(
  deps = {
    revision: () => apiClient.getConnectionRevision(),
    read: readClaudeResetGrants,
  }
) {
  let session = deps.revision();
  const inFlight = new Map<string, ReturnType<typeof readClaudeResetGrants>>();
  return (authIndex: string) => {
    const revision = deps.revision();
    if (revision !== session) {
      session = revision;
      inFlight.clear();
    }
    const existing = inFlight.get(authIndex);
    if (existing) return existing;
    const request = deps
      .read(authIndex)
      .then((result) => {
        if (deps.revision() !== revision) throw new Error('session');
        return result;
      })
      .finally(() => {
        if (inFlight.get(authIndex) === request) inFlight.delete(authIndex);
      });
    inFlight.set(authIndex, request);
    return request;
  };
}

export const readResetGrantsForCard = createResetGrantReader();

type CardRead = {
  session: number;
  /** The quota state the read belongs to. A new quota read makes the card read again. */
  refreshToken: unknown;
  reload: number;
  status: AnthropicResetGrantStatus;
};

const cardReads = new Map<string, CardRead>();

export const cardResetKey = (fileName: string, authIndex: string | null) =>
  JSON.stringify([fileName, authIndex]);
const cardReadListeners = new Set<() => void>();

/**
 * The last read per card. A revisit shows it at once, and skips the read unless the quota
 * changed since or the card asked for a reload. Spending still runs its own fresh preflight.
 */
export const cardResetReads = {
  known: (key: string, session: number): CardRead | undefined => {
    const read = cardReads.get(key);
    return read?.session === session ? read : undefined;
  },
  remember: (key: string, read: CardRead) => {
    cardReads.set(key, read);
    cardReadListeners.forEach((listener) => listener());
  },
  statuses: (session: number): Record<string, AnthropicResetGrantStatus> =>
    Object.fromEntries(
      [...cardReads]
        .filter(([, read]) => read.session === session)
        .map(([key, read]) => [key, read.status])
    ),
  /** Saved statuses show at once. No quota state matches their token, so cards re-read them. */
  restore: (statuses: Record<string, AnthropicResetGrantStatus>, session: number) => {
    Object.entries(statuses).forEach(([key, status]) =>
      cardReads.set(key, { session, refreshToken: null, reload: -1, status })
    );
  },
  /**
   * Reads a card's resets before its screen opens. The card then shows them at once and skips
   * its own delayed read while the quota it belongs to is unchanged.
   */
  prefetch: async (key: string, authIndex: string, refreshToken: unknown) => {
    const session = apiClient.getConnectionRevision();
    const status = await readResetGrantsForCard(authIndex);
    if (session !== apiClient.getConnectionRevision()) return;
    cardResetReads.remember(key, { session, refreshToken, reload: 0, status });
  },
  subscribe: (listener: () => void) => {
    cardReadListeners.add(listener);
    return () => {
      cardReadListeners.delete(listener);
    };
  },
};
