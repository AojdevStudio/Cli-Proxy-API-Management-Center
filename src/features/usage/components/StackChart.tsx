import { useTranslation } from 'react-i18next';
import { BRAND_COLORS, brandFor } from '../colors';
import { renderMessage, type StackBar } from '../logic';
import styles from '../UsagePage.module.scss';
import { Swatch } from './marks';

/** Token bars stacked by provider, colored by brand, with a provider legend. */
export function StackChart({
  bars,
  groups,
  label,
  note,
  variant,
}: {
  bars: StackBar[];
  groups: { key: string; label: string }[];
  label: string;
  note?: string;
  variant: 'hours' | 'days';
}) {
  const { t } = useTranslation();
  const max = Math.max(...bars.map((bar) => bar.total), 1);
  const [barsClass, ticksClass] =
    variant === 'hours' ? [styles.bars, styles.barTicks] : [styles.dayBars, styles.dayTicks];

  return (
    <figure className={styles.chart}>
      <div className={barsClass} role="img" aria-label={label}>
        {bars.map((bar, index) => (
          <div
            key={index}
            className={`${styles.bar} ${bar.state === 'now' ? styles.barNow : ''} ${
              bar.state === 'future' ? styles.barFuture : ''
            }`}
            title={renderMessage(t, bar.tip)}
          >
            {bar.state === 'future'
              ? null
              : bar.segments.map((segment) => (
                  <i
                    key={segment.label}
                    style={{
                      height: `${(100 * segment.tokens) / max}%`,
                      background: BRAND_COLORS[segment.brand],
                    }}
                  />
                ))}
          </div>
        ))}
      </div>
      <div className={ticksClass} aria-hidden="true">
        {bars.map((bar, index) => (
          <span key={index}>{bar.tick}</span>
        ))}
      </div>
      <figcaption className={styles.legend}>
        {groups.map((group) => (
          <span key={group.key}>
            <Swatch brand={brandFor(group.key)} />
            {group.label}
          </span>
        ))}
        {note ? <span>{note}</span> : null}
      </figcaption>
    </figure>
  );
}
