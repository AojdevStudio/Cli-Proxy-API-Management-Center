import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { ClaudeReservationState } from './useClaudeReservation';
import styles from '../../ledger/QuotaLedger.module.scss';

type ControlProps = {
  state: ClaudeReservationState;
  name: string;
  disabled: boolean;
  onToggle: () => void;
  onRetry: () => void;
};

export function ClaudeReservationStatus({ state }: Pick<ControlProps, 'state'>) {
  const { t } = useTranslation();
  const key =
    state.kind === 'ready' || state.kind === 'saving'
      ? state.reservation.fullAccess
        ? 'full_on'
        : 'reserve_on'
      : state.kind;
  return (
    <span role="status" className={styles.reservationStatus}>
      {t(`claude_reservation.${key}`)}
    </span>
  );
}

export function ClaudeReservationControl({
  state,
  name,
  disabled,
  onToggle,
  onRetry,
}: ControlProps) {
  const { t } = useTranslation();
  if (state.kind === 'loading' || state.kind === 'unsupported') return null;
  const retry = state.kind === 'error';
  const fullAccess = 'reservation' in state && state.reservation.fullAccess;
  const key = retry ? 'retry' : fullAccess ? 'restore' : 'use_full';
  return (
    <Button
      type="button"
      size="sm"
      variant={fullAccess || retry ? 'secondary' : 'primary'}
      className={styles.reservationButton}
      disabled={disabled || state.kind === 'saving'}
      aria-busy={state.kind === 'saving' || undefined}
      aria-label={t(`claude_reservation.${key}_label`, { name })}
      onClick={retry ? onRetry : onToggle}
    >
      {t(`claude_reservation.${state.kind === 'saving' ? 'saving' : key}`)}
    </Button>
  );
}
