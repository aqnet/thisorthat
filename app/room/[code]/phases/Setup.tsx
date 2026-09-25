'use client';

import { useState } from 'react';
import { confirmSetup } from '@/app/actions';
import { styles } from '@/components/game/ui';
import type { ListLength } from '@/lib/engine/constants';
import type { PhaseProps } from '../RoomClient';

/**
 * §7 Host Setup: category, then list length, then a confirmation card that
 * is the undo point. On a 45s timeout the server picks Random at the longest
 * length up to 10 and confirms on its own.
 */
export function Setup({ snap, room, roomCode, secondsLeft }: PhaseProps) {
  const me = snap.me!;
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [length, setLength] = useState<ListLength | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!me.isHost) {
    const host = snap.players.find((p) => p.isHost);
    return (
      <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
        <h1 className={styles.title}>{host?.name ?? 'The host'} is choosing…</h1>
        <p className={styles.body}>A category and how many items everyone lists.</p>
        {secondsLeft !== null && <p className={styles.hint}>Random pick in {secondsLeft}s if they can&apos;t decide.</p>}
      </section>
    );
  }

  const options = snap.categories;
  const category = options.find((c) => c.id === categoryId) ?? null;
  const lengths = category?.allowedLengths ?? [];

  function pickRandom() {
    const choice = options[Math.floor(Math.random() * options.length)];
    setCategoryId(choice.id);
    setLength(null);
  }

  if (confirming && category && length) {
    return (
      <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
        <p className={styles.eyebrow}>Ready?</p>
        <h1 className={styles.title}>
          {category.name} · {length} items
        </h1>
        <p className={styles.body}>{length} rounds. No changing the category after this.</p>
        <button
          type="button"
          className={styles.button}
          disabled={room.pending}
          onClick={() => room.act((t) => confirmSetup(t, roomCode, category.id, length))}
        >
          Start
        </button>
        <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={() => setConfirming(false)}>
          Back
        </button>
      </section>
    );
  }

  return (
    <>
      <h1 className={styles.title}>Pick a category</h1>
      <div className={styles.row}>
        {options.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`${styles.chip} ${c.id === categoryId ? styles.chipActive : ''}`}
            onClick={() => {
              setCategoryId(c.id);
              if (length && !c.allowedLengths.includes(length)) setLength(null);
            }}
          >
            {c.name}
          </button>
        ))}
        <button type="button" className={styles.chip} onClick={pickRandom}>
          🎲 Random
        </button>
      </div>

      <p className={styles.eyebrow}>Items per player</p>
      <div className={styles.row}>
        {([5, 10, 15] as const).map((l) => (
          <button
            key={l}
            type="button"
            className={`${styles.chip} ${l === length ? styles.chipActive : ''}`}
            disabled={!category || !lengths.includes(l)}
            onClick={() => setLength(l)}
          >
            {l}
          </button>
        ))}
      </div>
      {category && lengths.length < 3 && (
        <p className={styles.hint}>
          {category.name} goes up to {Math.max(...lengths)} — so nobody runs out of ideas.
        </p>
      )}

      <button
        type="button"
        className={styles.button}
        style={{ marginTop: 'auto' }}
        disabled={!category || !length}
        onClick={() => setConfirming(true)}
      >
        {category && length ? `${category.name} · ${length} items` : 'Choose a category and length'}
      </button>
    </>
  );
}
