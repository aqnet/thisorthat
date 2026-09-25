'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { closeRoom, endGame, leaveRoom, rejoinSeat } from '@/app/actions';
import { Scoreboard, Sheet, Timer, Toast, styles } from '@/components/game/ui';
import { useCountdown, useRoom } from '@/lib/client/useRoom';
import type { RoomSnapshot } from '@/lib/game/snapshot';
import { Lobby } from './phases/Lobby';
import { Setup } from './phases/Setup';
import { Entry } from './phases/Entry';
import { Reveal, Voting } from './phases/Matchup';
import { Results } from './phases/Results';

export type Room = ReturnType<typeof useRoom>;
export interface PhaseProps {
  snap: RoomSnapshot;
  room: Room;
  roomCode: string;
  /** Seconds left in the current phase, on the server's clock. */
  secondsLeft: number | null;
}

const IN_GAME = new Set(['setup', 'entering', 'computer_picking', 'matchup_voting', 'matchup_reveal', 'paused']);

export function RoomClient({ roomCode }: { roomCode: string }) {
  const router = useRouter();
  const room = useRoom(roomCode);
  const snap = room.snapshot;
  const secondsLeft = useCountdown(snap?.phaseDeadline ?? null, room.serverNow);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<'leave' | 'end' | 'cancel' | null>(null);

  // No seat here: go through the join screen, which handles every case (§6).
  useEffect(() => {
    if (snap && !snap.me && snap.status !== 'closed') router.replace(`/join/${roomCode}`);
  }, [snap, roomCode, router]);

  if (room.notFound) {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <h1 className={styles.title}>Room not found</h1>
        <Link href="/" className={styles.button}>
          New Game
        </Link>
      </main>
    );
  }

  if (!snap) {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <p className={styles.body}>{room.error ?? `Connecting to ${roomCode}…`}</p>
        {room.error && (
          <button type="button" className={styles.button} onClick={() => void room.refresh()}>
            Retry
          </button>
        )}
      </main>
    );
  }

  if (snap.status === 'closed') {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <h1 className={styles.title}>The host closed the room</h1>
        <Link href="/" className={styles.button}>
          Start your own
        </Link>
        <Link href="/" className={`${styles.button} ${styles.secondary}`}>
          Home
        </Link>
      </main>
    );
  }

  const me = snap.me;
  if (!me) return null;

  if (me.left && snap.status === 'lobby') {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <h1 className={styles.title}>You were removed from the room</h1>
        <Link href="/" className={styles.button}>
          Home
        </Link>
      </main>
    );
  }

  if (me.left) {
    // §9.7: your items stay in play; rejoining resumes voting next match-up.
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <h1 className={styles.title}>You left the game</h1>
        <p className={styles.body}>Your items are still in play. Rejoin to vote from the next match-up.</p>
        <button
          type="button"
          className={styles.button}
          disabled={room.pending}
          onClick={() => room.act((t) => rejoinSeat(t, roomCode, me.playerId))}
        >
          Rejoin
        </button>
        <Link href="/" className={`${styles.button} ${styles.secondary}`}>
          Home
        </Link>
      </main>
    );
  }

  const props: PhaseProps = { snap, room, roomCode, secondsLeft };
  const inGame = IN_GAME.has(snap.status);

  const leave = async () => {
    const result = await room.act((t) => leaveRoom(t, roomCode));
    if (result.ok) router.push('/');
  };

  return (
    <>
      <main className={styles.screen}>
        <div className={styles.topbar}>
          <span className={styles.eyebrow}>Room {snap.roomCode}</span>
          <div className={styles.row}>
            {!me.queued && snap.status !== 'matchup_reveal' && <Timer seconds={secondsLeft} />}
            <button type="button" className={styles.menuButton} onClick={() => setMenuOpen(true)} aria-label="Menu">
              ☰
            </button>
          </div>
        </div>

        {me.queued ? (
          <Queued {...props} />
        ) : snap.status === 'lobby' ? (
          <Lobby {...props} />
        ) : snap.status === 'setup' ? (
          <Setup {...props} />
        ) : snap.status === 'entering' ? (
          <Entry {...props} />
        ) : snap.status === 'computer_picking' ? (
          <Shuffling />
        ) : snap.status === 'matchup_voting' ? (
          <Voting {...props} />
        ) : snap.status === 'matchup_reveal' ? (
          <Reveal {...props} />
        ) : snap.status === 'paused' ? (
          <Paused {...props} onEnd={() => setConfirming('end')} />
        ) : snap.status === 'results' ? (
          <Results {...props} />
        ) : null}
      </main>

      {/* Every in-game screen has Leave, and the host has End Game (§2). */}
      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)}>
        <p className={styles.eyebrow}>Room {snap.roomCode}</p>
        <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={() => setConfirming('leave')}>
          Leave game
        </button>
        {me.isHost && inGame && (
          <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={() => setConfirming('end')}>
            End game for everyone
          </button>
        )}
        {me.isHost && snap.status === 'lobby' && (
          <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={() => setConfirming('cancel')}>
            Cancel room
          </button>
        )}
        <button type="button" className={styles.ghost} onClick={() => setMenuOpen(false)}>
          Close
        </button>
      </Sheet>

      <Sheet open={confirming !== null} onClose={() => setConfirming(null)}>
        <p className={styles.title} style={{ fontSize: 28 }}>
          {confirming === 'leave' ? 'Leave the game?' : confirming === 'end' ? 'End the game?' : 'Cancel the room?'}
        </p>
        <p className={styles.body}>
          {confirming === 'leave'
            ? inGame
              ? 'Your items stay in play and your score is frozen. You can rejoin.'
              : 'Your seat opens up for someone else.'
            : confirming === 'end'
              ? 'Everyone goes straight to results. Early endings don’t count for high scores.'
              : 'Everyone is sent home.'}
        </p>
        <button
          type="button"
          className={styles.button}
          disabled={room.pending}
          onClick={async () => {
            const which = confirming;
            setConfirming(null);
            setMenuOpen(false);
            if (which === 'leave') await leave();
            else if (which === 'end') await room.act((t) => endGame(t, roomCode));
            else if (which === 'cancel') {
              const result = await room.act((t) => closeRoom(t, roomCode));
              if (result.ok) router.push('/');
            }
          }}
        >
          {confirming === 'leave' ? 'Leave' : confirming === 'end' ? 'End game' : 'Cancel room'}
        </button>
        <button type="button" className={styles.ghost} onClick={() => setConfirming(null)}>
          Keep playing
        </button>
      </Sheet>

      <Toast message={room.toast} onClose={room.clearToast} />
    </>
  );
}

function Shuffling() {
  return (
    <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
      <h1 className={styles.title}>Lists locked</h1>
      <p className={styles.body}>The Computer is picking its items and shuffling the ballots…</p>
    </section>
  );
}

/** §6: queued joiners see a live, read-only scoreboard while they wait. */
function Queued({ snap }: PhaseProps) {
  return (
    <section className={styles.stack}>
      <h1 className={styles.title}>You&apos;re in for the next game</h1>
      <p className={styles.body}>
        A game is in progress. You&apos;ll be seated when the host taps Play Again, if a seat is free.
      </p>
      {snap.game && snap.game.standings.length > 0 && <Scoreboard rows={snap.game.standings} />}
    </section>
  );
}

/** §9.7: below 2 connected humans the game pauses with a 60s countdown. */
function Paused({ snap, secondsLeft, onEnd }: PhaseProps & { onEnd: () => void }) {
  return (
    <section className={`${styles.stack} ${styles.center}`}>
      <h1 className={styles.title}>Waiting for players…</h1>
      <p className={styles.body}>
        The game needs 2 connected players. It ends automatically in {secondsLeft ?? '…'}s if nobody comes back.
      </p>
      {snap.me?.isHost && (
        <div className={styles.stack} style={{ width: '100%' }}>
          <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={onEnd}>
            End game
          </button>
          <p className={styles.hint}>Or keep waiting — the game resumes as soon as someone reconnects.</p>
        </div>
      )}
    </section>
  );
}
