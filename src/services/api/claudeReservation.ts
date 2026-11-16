import type { AuthFileItem } from '@/types';
import { isRecord } from '@/utils/helpers';
import type { AuthFileFieldsPatch } from './authFiles';
import { apiClient } from './client';

export type ClaudeReservation = {
  fullAccess: boolean;
  reserveExcludedModels: string[];
};

type ReservationErrorCode =
  'unsupported' | 'identity' | 'stale' | 'busy' | 'read_failed' | 'write_failed';

export class ClaudeReservationError extends Error {
  constructor(public readonly code: ReservationErrorCode) {
    super(`Claude reservation failed (${code})`);
    this.name = 'ClaudeReservationError';
  }
}

// The reserved account is fixed by the approved gateway policy in homelab issue 1166.
export const isReservedClaudeAccount = (file: AuthFileItem): boolean =>
  (file.type ?? file.provider) === 'claude' && file.name.startsWith('claude-9ef827e2');

function parseReservation(value: unknown): ClaudeReservation {
  if (!isRecord(value)) throw new ClaudeReservationError('unsupported');
  const fullAccess =
    value.quota_priority_full_access === undefined ? false : value.quota_priority_full_access;
  const reserveExcludedModels = value.quota_priority_reserve_excluded_models;
  if (
    typeof fullAccess !== 'boolean' ||
    !Array.isArray(reserveExcludedModels) ||
    !reserveExcludedModels.every(
      (model): model is string => typeof model === 'string' && model.trim().length > 0
    )
  ) {
    throw new ClaudeReservationError('unsupported');
  }
  return { fullAccess, reserveExcludedModels };
}

function reservationConnection(file: AuthFileItem, revision: number, current: () => boolean) {
  const assertCurrent = () => {
    if (revision !== apiClient.getConnectionRevision() || !current()) {
      throw new ClaudeReservationError('stale');
    }
    if (!isReservedClaudeAccount(file)) throw new ClaudeReservationError('identity');
  };
  assertCurrent();
  const client = apiClient.captureConnection();
  return {
    client,
    assertCurrent,
    read: async (): Promise<ClaudeReservation> => {
      try {
        const blob = await client.get<Blob>(
          `/credentials/download?name=${encodeURIComponent(file.name)}`,
          { responseType: 'blob' }
        );
        const value: unknown = JSON.parse(await blob.text());
        assertCurrent();
        return parseReservation(value);
      } catch (error) {
        assertCurrent();
        if (error instanceof ClaudeReservationError) throw error;
        throw new ClaudeReservationError('read_failed');
      }
    },
  };
}

const writes = new Set<string>();

export const claudeReservationApi = {
  read: async (file: AuthFileItem, revision: number, current: () => boolean = () => true) =>
    reservationConnection(file, revision, current).read(),

  async setFullAccess(
    file: AuthFileItem,
    fullAccess: boolean,
    revision: number,
    current: () => boolean = () => true
  ): Promise<ClaudeReservation> {
    const connection = reservationConnection(file, revision, current);
    const key = JSON.stringify([revision, file.name]);
    if (writes.has(key)) throw new ClaudeReservationError('busy');
    writes.add(key);
    try {
      const reservation = await connection.read();
      connection.assertCurrent();
      const fields = {
        quota_priority_full_access: fullAccess,
        excluded_models: fullAccess ? [] : reservation.reserveExcludedModels,
      } satisfies AuthFileFieldsPatch;
      try {
        await connection.client.patch('/credentials/fields', { name: file.name, ...fields });
      } catch {
        connection.assertCurrent();
        throw new ClaudeReservationError('write_failed');
      }
      connection.assertCurrent();
      return { ...reservation, fullAccess };
    } finally {
      writes.delete(key);
    }
  },
};
