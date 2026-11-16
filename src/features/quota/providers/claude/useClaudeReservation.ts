import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { apiClient } from '@/services/api/client';
import {
  claudeReservationApi,
  ClaudeReservationError,
  isReservedClaudeAccount,
  type ClaudeReservation,
} from '@/services/api/claudeReservation';
import type { AuthFileItem } from '@/types';

export type ClaudeReservationState =
  | { kind: 'loading' | 'error' | 'unsupported' }
  | { kind: 'ready' | 'saving'; reservation: ClaudeReservation };

type Snapshot = {
  file: AuthFileItem;
  revision: number;
  state: ClaudeReservationState;
};

export function useClaudeReservation(file: AuthFileItem, disabled: boolean) {
  const { name, type, provider, authIndex, auth_index } = file;
  const generation = useQuotaStore((state) => state.fileGenerations[name] ?? 0);
  const credential = useMemo(
    () => ({ name, type, provider, authIndex, auth_index, generation }),
    [name, type, provider, authIndex, auth_index, generation]
  );
  const { t } = useTranslation();
  const connected = useAuthStore(
    (state) => state.isAuthenticated && state.connectionStatus === 'connected'
  );
  const showNotification = useNotificationStore((state) => state.showNotification);
  const revision = apiClient.getConnectionRevision();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [reload, setReload] = useState(0);
  const scope = useRef<{ current: () => boolean } | null>(null);
  const lock = useRef<(() => boolean) | null>(null);
  const supportedAccount = isReservedClaudeAccount(credential);

  useEffect(() => {
    if (!connected || !supportedAccount) return;
    let active = true;
    const current = () => {
      const auth = useAuthStore.getState();
      return (
        active &&
        auth.isAuthenticated &&
        auth.connectionStatus === 'connected' &&
        revision === apiClient.getConnectionRevision()
      );
    };
    scope.current = { current };
    void claudeReservationApi.read(credential, revision, current).then(
      (reservation) => {
        if (current())
          setSnapshot({ file: credential, revision, state: { kind: 'ready', reservation } });
      },
      (error: unknown) => {
        if (current()) {
          setSnapshot({
            file: credential,
            revision,
            state: {
              kind:
                error instanceof ClaudeReservationError && error.code === 'unsupported'
                  ? 'unsupported'
                  : 'error',
            },
          });
        }
      }
    );
    return () => {
      active = false;
      scope.current = null;
    };
  }, [credential, revision, connected, supportedAccount, reload]);

  const state: ClaudeReservationState =
    connected && snapshot?.file === credential && snapshot.revision === revision
      ? snapshot.state
      : { kind: 'loading' };

  const retry = () => {
    if (lock.current?.() || disabled || !connected) return;
    setSnapshot(null);
    setReload((value) => value + 1);
  };

  const toggle = async () => {
    const current = scope.current?.current;
    if (disabled || lock.current?.() || state.kind !== 'ready' || !current?.()) return;
    lock.current = current;
    setSnapshot({
      file: credential,
      revision,
      state: { kind: 'saving', reservation: state.reservation },
    });
    try {
      const reservation = await claudeReservationApi.setFullAccess(
        credential,
        !state.reservation.fullAccess,
        revision,
        current
      );
      if (!current()) return;
      setSnapshot({ file: credential, revision, state: { kind: 'ready', reservation } });
      showNotification(
        t(reservation.fullAccess ? 'claude_reservation.full_on' : 'claude_reservation.reserve_on'),
        'success'
      );
    } catch (error) {
      if (!current()) return;
      const unsupported = error instanceof ClaudeReservationError && error.code === 'unsupported';
      setSnapshot({
        file: credential,
        revision,
        state: { kind: unsupported ? 'unsupported' : 'error' },
      });
      showNotification(t('claude_reservation.change_failed'), 'error');
    } finally {
      if (lock.current === current) lock.current = null;
    }
  };

  return { state, retry, toggle, disabled: disabled || !connected };
}
