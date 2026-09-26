'use client';

import { useState } from 'react';
import { confirmSetup, selectMode } from '@/app/actions';
import { styles } from '@/components/game/ui';
import type { ListLength } from '@/lib/engine/constants';
import type { GameMode } from '@/lib/engine/types';
import { MODE_INFO, MODE_ORDER } from '@/lib/game/modes';
import type { PhaseProps } from '../RoomClient';

/**
 * §7 Host Setup, with the mode step first (mode spec §3): mode, category,
 * list length, then a confirmation card that is the undo point. On a 45s
 * timeout the server keeps the selected mode, picks Random at the longest
 * length up to 10, and confirms on its own.
 */
export function Setup({ snap, room, roomCode, secondsLeft }: PhaseProps) {
  const me = snap.me!;
  const mode = snap.game?.mode ?? 'pick_your_fav';
  const [pickingMode, setPickingMode] = useState(true);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [length, setLength] = useState<ListLength | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!me.isHost) {
    const host = snap.players.find((p) => p.isHost);
    return (
      <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
        <h1 className={styles.title}>{host?.name ?? 'The host'} is choosing…</h1>
        <p className={styles.body}>A game mode, a category, and how many items everyone lists.</p>
        <p className={styles.hint}>
          Mode so far: <strong>{MODE_INFO[mode].name}</strong>
        </p>
        {secondsLeft !== null && <p className={styles.hint}>Random pick in {secondsLeft}s if they can&apos;t decide.</p>}
      </section>
    );
  }

  // Mode spec §3a: the room's last mode is pre-selected; one tap moves on.
  if (pickingMode) {
    const choose = async (next: GameMode) => {
      if (next !== mode) {
        const result = await room.act((t) => selectMode(t, roomCode, next));
        if (!result.ok) return;
      }
      setPickingMode(false);
    };
    return (
      <>
        <h1 className={styles.title}>Pick a game mode</h1>
        <div className={styles.stack}>
          {MODE_ORDER.map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.modeCard} ${m === mode ? styles.modeCardActive : ''}`}
              disabled={room.pending}
              onClick={() => choose(m)}
              aria-pressed={m === mode}
            >
              <span className={styles.modeName}>{MODE_INFO[m].name}</span>
              <span className={styles.modePitch}>{MODE_INFO[m].pitch}</span>
            </button>
          ))}
        </div>
      </>
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
          {MODE_INFO[mode].name} · {category.name} · {length} items
        </h1>
        <p className={styles.body}>{length} rounds. No changing the category after this.</p>
        <button
          type="button"
          className={styles.button}
          disabled={room.pending}
          onClick={() => room.act((t) => confirmSetup(t, roomCode, category.id, length, mode))}
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
      <button type="button" className={styles.ghost} style={{ alignSelf: 'flex-start' }} onClick={() => setPickingMode(true)}>
        ← {MODE_INFO[mode].name}
      </button>
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
