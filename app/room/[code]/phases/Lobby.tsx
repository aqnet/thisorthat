'use client';

import { useState } from 'react';
import { removePlayer, setRelaxedTimers, startGame } from '@/app/actions';
import { PlayerRow, QrCode, Sheet, styles } from '@/components/game/ui';
import { MIN_HUMANS } from '@/lib/engine/constants';
import type { PhaseProps } from '../RoomClient';

/** §4-§5: share the room, watch players arrive, host starts at 2+ humans. */
export function Lobby({ snap, room, roomCode }: PhaseProps) {
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const me = snap.me!;
  const seated = snap.players.filter((p) => !p.isComputer && !p.queued && !p.left);
  const computer = snap.players.find((p) => p.isComputer);
  const missing = Math.max(0, MIN_HUMANS - seated.length);
  const joinUrl = typeof window === 'undefined' ? `/join/${roomCode}` : `${window.location.origin}/join/${roomCode}`;

  async function share() {
    if (navigator.share) {
      await navigator.share({ title: 'This or That', text: `Join my game: ${roomCode}`, url: joinUrl }).catch(() => {});
      return;
    }
    await navigator.clipboard?.writeText(joinUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <section className={`${styles.panel} ${styles.center}`} style={{ display: 'grid', justifyItems: 'center' }}>
        <p className={styles.eyebrow}>Join at {joinUrl.replace(/^https?:\/\//, '').replace(/\/join\/.*/, '')} with code</p>
        <p className={styles.roomCode}>{roomCode}</p>
        <QrCode value={joinUrl} />
        <button type="button" className={`${styles.button} ${styles.secondary} ${styles.small}`} onClick={share}>
          {copied ? 'Link copied ✓' : 'Share link'}
        </button>
      </section>

      <section className={styles.stack}>
        <div className={styles.spread}>
          <p className={styles.eyebrow}>Players · {seated.length} of 4</p>
        </div>
        {seated.map((p) => (
          <PlayerRow key={p.id} player={p} you={p.id === me.playerId}>
            {me.isHost && p.id !== me.playerId && (
              <button type="button" className={styles.ghost} onClick={() => setRemoving({ id: p.id, name: p.name })}>
                Remove
              </button>
            )}
          </PlayerRow>
        ))}
        {computer && <PlayerRow player={computer} />}
      </section>

      {me.isHost ? (
        <section className={styles.stack} style={{ marginTop: 'auto' }}>
          <label className={styles.spread}>
            <span>
              <strong>Relaxed timers</strong>
              <br />
              <span className={styles.hint}>1.5× time for setup and entering items</span>
            </span>
            <input
              type="checkbox"
              checked={snap.relaxedTimers}
              disabled={room.pending}
              onChange={(e) => room.act((t) => setRelaxedTimers(t, roomCode, e.target.checked))}
              style={{ width: 24, height: 24 }}
            />
          </label>
          {/* Start explains why it's disabled (§5). */}
          <button
            type="button"
            className={styles.button}
            disabled={missing > 0 || room.pending}
            onClick={() => room.act((t) => startGame(t, roomCode))}
          >
            {missing > 0 ? `Need ${missing} more player${missing === 1 ? '' : 's'}` : 'Start'}
          </button>
        </section>
      ) : (
        <p className={styles.body} style={{ marginTop: 'auto', textAlign: 'center' }}>
          Waiting for {snap.players.find((p) => p.isHost)?.name ?? 'the host'} to start…
        </p>
      )}

      <Sheet open={removing !== null} onClose={() => setRemoving(null)}>
        <p className={styles.title} style={{ fontSize: 28 }}>
          Remove {removing?.name}?
        </p>
        <button
          type="button"
          className={styles.button}
          onClick={async () => {
            const target = removing!;
            setRemoving(null);
            await room.act((t) => removePlayer(t, roomCode, target.id));
          }}
        >
          Remove
        </button>
        <button type="button" className={styles.ghost} onClick={() => setRemoving(null)}>
          Cancel
        </button>
      </Sheet>
    </>
  );
}
