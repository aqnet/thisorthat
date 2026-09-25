'use client';

import { useState } from 'react';
import { addItem, editList, removeItem, submitList, surpriseMe } from '@/app/actions';
import { styles } from '@/components/game/ui';
import { accessToken } from '@/lib/client/supabase';
import type { PhaseProps } from '../RoomClient';

function plural(category: string | null): string {
  if (!category) return 'items';
  const lower = category.toLocaleLowerCase('en-US');
  return lower.endsWith('s') ? lower : `${lower}s`;
}

/**
 * §8 Enter Items. Your list is private: others see counters only ("Maya
 * 6/10"). Every rejection shows its reason inline under the field.
 */
export function Entry({ snap, room, roomCode }: PhaseProps) {
  const game = snap.game!;
  const me = snap.me!;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ dictionaryId: number; name: string; typed: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const target = game.listLength ?? 0;
  const count = game.myList.length;
  const full = count >= target;
  const submitted = game.mySubmitted;
  const names = new Map(snap.players.map((p) => [p.id, p.name]));
  const waitingOn = game.entryProgress.filter((p) => !p.submitted && p.playerId !== me.playerId);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  async function add(choice?: { kind: 'suggestion'; dictionaryId: number } | { kind: 'mine' }) {
    const typed = suggestion?.typed ?? text;
    setBusy(true);
    setError(null);
    try {
      const result = await addItem(await accessToken(), roomCode, typed, choice);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.suggestion) {
        setSuggestion({ ...result.suggestion, typed });
        return;
      }
      setSuggestion(null);
      // Only clear what was submitted: a fast typer may already be on the next item.
      setText((current) => (current === typed ? '' : current));
      void room.refresh();
    } catch {
      setError("Couldn't reach the game. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.stack}>
        <h1 className={styles.title}>
          List {target} {plural(game.categoryName)} you&apos;ll defend
        </h1>
        <p className={styles.body}>Points go to the picks everyone else loves.</p>
      </div>

      {!submitted && (
        <form
          className={styles.stack}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && !full) void add();
          }}
        >
          <div className={styles.row} style={{ flexWrap: 'nowrap' }}>
            <input
              className={`${styles.input} ${styles.grow}`}
              value={suggestion ? suggestion.typed : text}
              onChange={(e) => {
                setText(e.target.value);
                setSuggestion(null);
                setError(null);
              }}
              maxLength={40}
              disabled={full}
              placeholder={full ? 'List full' : `A ${game.categoryName?.toLowerCase() ?? 'item'}…`}
              autoComplete="off"
              enterKeyHint="done"
              aria-label="Add an item"
            />
            <button className={`${styles.button} ${styles.small}`} disabled={busy || full || !(text.trim() || suggestion)}>
              Add
            </button>
          </div>
          {error && <p className={styles.error}>{error}</p>}
          {suggestion && (
            <div className={styles.suggestion}>
              <span>
                Did you mean <strong>{suggestion.name}</strong>?
              </span>
              <div className={styles.row}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.small}`}
                  disabled={busy}
                  onClick={() => add({ kind: 'suggestion', dictionaryId: suggestion.dictionaryId })}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className={`${styles.button} ${styles.secondary} ${styles.small}`}
                  disabled={busy}
                  onClick={() => add({ kind: 'mine' })}
                >
                  Keep mine
                </button>
              </div>
            </div>
          )}
          <div className={styles.spread}>
            <button
              type="button"
              className={`${styles.chip}`}
              disabled={busy || full}
              onClick={() => run(() => room.act((t) => surpriseMe(t, roomCode)))}
            >
              🎲 Surprise me
            </button>
            <span className={`${styles.score}`} aria-live="polite">
              {count} / {target}
            </span>
          </div>
        </form>
      )}

      <ol className={styles.stack} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {game.myList.map((item, i) => (
          <li key={item.id} className={styles.item}>
            <span className={styles.itemIndex}>{i + 1}</span>
            <span className={styles.grow}>
              {item.displayText}
              {item.surprise ? ' 🎲' : ''}
            </span>
            {!submitted && (
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${item.displayText}`}
                disabled={busy}
                onClick={() => room.act((t) => removeItem(t, roomCode, item.id))}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ol>

      <section className={styles.stack} style={{ marginTop: 'auto' }}>
        <p className={styles.hint}>
          {game.entryProgress
            .filter((p) => p.playerId !== me.playerId)
            .map((p) => `${names.get(p.playerId)} ${p.submitted ? '✓' : `${p.count}/${target}`}`)
            .join(' · ')}
        </p>
        {submitted ? (
          <>
            <p className={styles.body}>
              List locked in ✓
              {waitingOn.length > 0 && ` · Waiting on ${waitingOn.map((p) => names.get(p.playerId)).join(', ')}…`}
            </p>
            <button
              type="button"
              className={`${styles.button} ${styles.secondary}`}
              disabled={room.pending}
              onClick={() => room.act((t) => editList(t, roomCode))}
            >
              Edit
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.button}
            disabled={!full || room.pending}
            onClick={() => room.act((t) => submitList(t, roomCode))}
          >
            {full ? 'Submit' : `Add ${target - count} more`}
          </button>
        )}
      </section>
    </>
  );
}
