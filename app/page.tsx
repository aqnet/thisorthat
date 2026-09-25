'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createRoom } from '@/app/actions';
import { ChoiceCard } from '@/components/ChoiceCard';
import { Sheet, styles as game } from '@/components/game/ui';
import { accessToken } from '@/lib/client/supabase';
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
  const router = useRouter();
  const [sheet, setSheet] = useState<'new' | 'join' | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (which: 'new' | 'join') => {
    setError(null);
    setSheet(which);
  };

  // §4: the host is seated as Player 1 with the Computer alongside.
  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createRoom(await accessToken(), name);
      if (result.ok) router.push(`/room/${result.roomCode}`);
      else setError(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create a room");
    } finally {
      setBusy(false);
    }
  }

  function onJoin(event: React.FormEvent) {
    event.preventDefault();
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(clean)) {
      setError('Room codes are 4 letters');
      return;
    }
    router.push(`/join/${clean}`);
  }

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
        <button type="button" className={`${styles.action} ${styles.primary}`} onClick={() => open('new')}>
          New Game
        </button>
        <button type="button" className={`${styles.action} ${styles.secondary}`} onClick={() => open('join')}>
          Join
        </button>
        <button type="button" className={`${styles.action} ${styles.secondary}`} disabled title="Coming soon">
          High Scores · soon
        </button>
      </div>

      <Sheet open={sheet === 'new'} onClose={() => setSheet(null)}>
        <form className={game.stack} onSubmit={onCreate}>
          <p className={game.eyebrow}>New game</p>
          <label className={game.stack}>
            <span className={game.hint}>Your name</span>
            <input
              className={game.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={12}
              autoFocus
              autoComplete="nickname"
              placeholder="Up to 12 letters"
            />
          </label>
          {error && <p className={game.error}>{error}</p>}
          <button className={game.button} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create room'}
          </button>
          <button type="button" className={game.ghost} onClick={() => setSheet(null)}>
            Cancel
          </button>
        </form>
      </Sheet>

      <Sheet open={sheet === 'join'} onClose={() => setSheet(null)}>
        <form className={game.stack} onSubmit={onJoin}>
          <p className={game.eyebrow}>Join a room</p>
          <input
            className={`${game.input} ${game.codeInput}`}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="KZPW"
            aria-label="Room code"
          />
          {error && <p className={game.error}>{error}</p>}
          <button className={game.button} disabled={code.length !== 4}>
            Join
          </button>
          <button type="button" className={game.ghost} onClick={() => setSheet(null)}>
            Cancel
          </button>
        </form>
      </Sheet>

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
