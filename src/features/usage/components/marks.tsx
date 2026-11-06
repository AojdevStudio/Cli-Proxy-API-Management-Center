import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BRAND_COLORS, type BrandId } from '../colors';
import { renderMessage, type StatusMark } from '../logic';
import styles from '../UsagePage.module.scss';

const TONE_CLASS = { danger: styles.toneDanger, warn: styles.toneWarn } as const;

/** Text in a status color. Always paired with a StatusWord that says the same. */
export function ToneText({ mark, children }: { mark: StatusMark | null; children: ReactNode }) {
  return <span className={mark ? TONE_CLASS[mark.tone] : undefined}>{children}</span>;
}

export function StatusWord({ mark }: { mark: StatusMark | null }) {
  const { t } = useTranslation();
  if (!mark) return null;
  return (
    <span className={`${styles.statusWord} ${TONE_CLASS[mark.tone]}`}>
      {renderMessage(t, mark.word)}
    </span>
  );
}

export function Swatch({ brand }: { brand: BrandId }) {
  return (
    <span
      className={styles.swatch}
      style={{ background: BRAND_COLORS[brand] }}
      aria-hidden="true"
    />
  );
}
