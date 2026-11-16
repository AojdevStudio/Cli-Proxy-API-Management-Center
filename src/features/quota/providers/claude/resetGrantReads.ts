import { apiClient } from '@/services/api/client';
import {
  readClaudeResetGrantsForDisplay,
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

export const readResetGrantsForCard = readClaudeResetGrantsForDisplay;

/** The reset endpoint is rate limited. A quota refresh re-reads resets at most this often. */
export const CARD_RESET_READ_MIN_AGE_MS = 30 * 60 * 1000;

type CardRead = {
  session: number;
  /** The quota state the read belongs to. */
  refreshToken: unknown;
  reload: number;
  readAt: number;
  status: AnthropicResetGrantStatus;
};

export type SavedCardRead = Pick<CardRead, 'readAt' | 'status'>;

const cardReads = new Map<string, CardRead>();

export const cardResetKey = (fileName: string, authIndex: string | null) =>
  JSON.stringify([fileName, authIndex]);
const cardReadListeners = new Set<() => void>();

/**
 * The last read per card. A revisit shows it at once. A card reads again after it asks for a
 * reload, or when its quota changed and the read is older than CARD_RESET_READ_MIN_AGE_MS.
 * Spending still runs its own fresh preflight.
 */
export const cardResetReads = {
  clear: (names?: string[]) => {
    for (const key of cardReads.keys()) {
      if (!names || names.some((name) => key.startsWith(`[${JSON.stringify(name)},`))) {
        cardReads.delete(key);
      }
    }
    cardReadListeners.forEach((listener) => listener());
  },
  known: (key: string, session: number): CardRead | undefined => {
    const read = cardReads.get(key);
    return read?.session === session ? read : undefined;
  },
  remember: (key: string, read: CardRead) => {
    cardReads.set(key, read);
    cardReadListeners.forEach((listener) => listener());
  },
  isCurrent: (read: CardRead, refreshToken: unknown, reload: number, now: number) =>
    read.reload === reload &&
    (read.refreshToken === refreshToken || now - read.readAt < CARD_RESET_READ_MIN_AGE_MS),
  saved: (session: number): Record<string, SavedCardRead> =>
    Object.fromEntries(
      [...cardReads]
        .filter(([, read]) => read.session === session)
        .map(([key, { readAt, status }]) => [key, { readAt, status }])
    ),
  /** Saved reads show at once and count as fresh until they pass the minimum age. */
  restore: (saved: Record<string, SavedCardRead>, session: number) => {
    Object.entries(saved).forEach(([key, read]) =>
      cardReads.set(key, { session, refreshToken: null, reload: 0, ...read })
    );
  },
  /**
   * Reads a card's resets before its screen opens. The card then shows them at once and skips
   * its own delayed read while the quota it belongs to is unchanged.
   */
  prefetch: async (key: string, authIndex: string, refreshToken: unknown) => {
    const session = apiClient.getConnectionRevision();
    const known = cardResetReads.known(key, session);
    if (known && cardResetReads.isCurrent(known, refreshToken, 0, Date.now())) return;
    const status = await readResetGrantsForCard(authIndex);
    if (session !== apiClient.getConnectionRevision()) return;
    cardResetReads.remember(key, { session, refreshToken, reload: 0, readAt: Date.now(), status });
  },
  subscribe: (listener: () => void) => {
    cardReadListeners.add(listener);
    return () => {
      cardReadListeners.delete(listener);
    };
  },
};
