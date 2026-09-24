'use client';

import { useState } from 'react';
import { ChoiceCard } from '@/components/ChoiceCard';
import { useTheme } from '@/lib/theme/ThemeProvider';
import { MODES, THEMES, THEME_BLURBS, THEME_LABELS } from '@/lib/theme/themes';
import styles from './home.module.css';

/**
 * Home (§3): New Game, Join, High Scores, Settings.
 *
 * The settings panel shows a live preview of the choice card rather than just
 * theme names, so the difference between Duel's edge-to-edge split and Candy
 * Pop's floating cards is visible before you commit (design spec §2).
 */
export default function HomePage() {
  const { theme, mode, setTheme, setMode } = useTheme();
  const [picked, setPicked] = useState<'a' | 'b' | null>(null);

  return (
    <main className={styles.page}>
      <h1 className={styles.wordmark}>
        This<span className={styles.or}>or</span>That
      </h1>

      <p className={styles.tagline}>
        A party game for 2&ndash;4 phones, plus the Computer.
        <br />
        Points go to the picks everyone else loves.
      </p>

      <div className={styles.actions}>
        <button type="button" className={`${styles.action} ${styles.primary}`}>
          New Game
        </button>
        <button type="button" className={`${styles.action} ${styles.secondary}`}>
          Join
        </button>
        <button type="button" className={`${styles.action} ${styles.secondary}`}>
          High Scores
        </button>
      </div>

      <section className={styles.panel} aria-label="Settings">
        <h2 className={styles.panelTitle}>Theme</h2>
        <div className={styles.row}>
          {THEMES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTheme(name)}
              aria-pressed={theme === name}
              className={`${styles.chip} ${theme === name ? styles.chipActive : ''}`}
            >
              {THEME_LABELS[name]}
            </button>
          ))}
        </div>
        <p className={styles.blurb}>{THEME_BLURBS[theme]}</p>

        <ChoiceCard optionA="Mango" optionB="Pineapple" theme={theme} onChoose={setPicked} />
        <p className={styles.blurb} aria-live="polite">
          {picked ? `You'd defend side ${picked.toUpperCase()}.` : 'Tap a side to preview the motion.'}
        </p>

        <h2 className={styles.panelTitle}>Mode</h2>
        <div className={styles.row}>
          {MODES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setMode(name)}
              aria-pressed={mode === name}
              className={`${styles.chip} ${mode === name ? styles.chipActive : ''}`}
            >
              {name[0].toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>

        <h2 className={styles.panelTitle}>Seats</h2>
        <div className={styles.seats}>
          {[1, 2, 3, 4].map((slot) => (
            <span
              key={slot}
              className={styles.seat}
              style={{ background: `var(--player-${slot})` }}
              title={`Player ${slot}`}
            >
              P{slot}
            </span>
          ))}
          <span
            className={styles.seat}
            style={{ background: 'var(--player-computer)' }}
            title="Computer"
          >
            AI
          </span>
          <span className={styles.blurb}>4 seats + the Computer</span>
        </div>
      </section>
    </main>
  );
}
