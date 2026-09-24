import { THEME_LAYOUT, type ThemeName } from '@/lib/theme/themes';
import styles from './ChoiceCard.module.css';

interface ChoiceCardProps {
  optionA: string;
  optionB: string;
  theme: ThemeName;
  onChoose?: (side: 'a' | 'b') => void;
}

/**
 * Side A is warm and Side B is cool in every theme and mode, so players learn
 * the mapping in one round and it never changes (design spec principle 1).
 *
 * Both labels are uppercased here for display only -- this is the settings
 * preview, not a ballot. Real ballot text is uppercased on the server before
 * it is stored, because CSS would leave the original casing in the payload
 * and give away who wrote the item (game spec §9.1).
 */
export function ChoiceCard({ optionA, optionB, theme, onChoose }: ChoiceCardProps) {
  const variant = THEME_LAYOUT[theme];
  return (
    <div className={`${styles.root} ${styles[variant]}`}>
      <button
        type="button"
        className={`${styles.side} ${styles.sideA}`}
        onClick={() => onChoose?.('a')}
      >
        {optionA}
      </button>
      <span className={styles.badge} aria-hidden="true">
        or
      </span>
      <button
        type="button"
        className={`${styles.side} ${styles.sideB}`}
        onClick={() => onChoose?.('b')}
      >
        {optionB}
      </button>
    </div>
  );
}
