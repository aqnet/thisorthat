'use client';

import { useRouter } from 'next/navigation';
import { closeRoom, leaveRoom, newRoom, playAgain } from '@/app/actions';
import { PlayerDot, styles } from '@/components/game/ui';
import type { PhaseProps } from '../RoomClient';

/**
 * §10 Final Results and §11 After the Game: the podium with percentage
 * scores, the Computer outcome, fun stats, and the host's next step.
 */
export function Results({ snap, room, roomCode }: PhaseProps) {
  const router = useRouter();
  const game = snap.game!;
  const results = game.results;
  const me = snap.me!;
  const winners = game.standings.filter((r) => r.rank === 1);
  const topHuman = game.standings.find((r) => r.playerId === results?.topHumanId);

  const headline = results?.computerWon
    ? 'The Computer wins'
    : winners.length > 1
      ? `${winners.map((w) => w.name).join(' & ')} share the win`
      : `${winners[0]?.name ?? 'Nobody'} wins!`;

  return (
    <>
      {game.endedEarly && <p className={`${styles.tag}`} style={{ alignSelf: 'flex-start' }}>Game ended early</p>}
      <h1 className={styles.title}>{headline}</h1>
      {results?.computerWon && topHuman && (
        <p className={styles.body}>
          Top Human: <strong>{topHuman.name}</strong>
        </p>
      )}

      <section className={styles.stack}>
        {game.standings.map((row) => (
          <div
            key={row.playerId}
            className={`${styles.player} ${row.rank === 1 ? styles.podiumFirst : ''} ${row.left ? styles.faded : ''}`}
          >
            <span className={styles.rank}>{row.rank}</span>
            <PlayerDot name={row.name} colorSlot={row.colorSlot} isComputer={row.isComputer} />
            <span className={styles.playerName}>
              {row.name}
              {row.playerId === me.playerId ? ' (you)' : ''}
            </span>
            {results?.beatComputerIds.includes(row.playerId) && (
              <span className={`${styles.tag} ${styles.sparkTag}`}>Beat the Computer</span>
            )}
            <span className={styles.score}>
              {row.pct !== null && <span className={styles.hint}>{row.pct}% · </span>}
              {row.score}
            </span>
          </div>
        ))}
      </section>

      {results && results.funStats.length > 0 && (
        <section className={styles.panel}>
          {results.funStats.map((stat) => (
            <div key={stat.label}>
              <p className={styles.eyebrow}>{stat.label}</p>
              <p style={{ margin: '2px 0 0', fontWeight: 700 }}>{stat.detail}</p>
            </div>
          ))}
        </section>
      )}

      {game.endedEarly && <p className={styles.hint}>Early endings don&apos;t count toward high scores.</p>}

      <section className={styles.stack} style={{ marginTop: 'auto' }}>
        {me.isHost ? (
          <>
            <button
              type="button"
              className={styles.button}
              disabled={room.pending}
              onClick={() => room.act((t) => playAgain(t, roomCode))}
            >
              Play again
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.secondary}`}
              disabled={room.pending}
              onClick={async () => {
                const result = await room.act((t) => newRoom(t, roomCode));
                if (result.ok) router.push(`/room/${result.roomCode}`);
              }}
            >
              New room
            </button>
            <button
              type="button"
              className={styles.ghost}
              disabled={room.pending}
              onClick={async () => {
                const result = await room.act((t) => closeRoom(t, roomCode));
                if (result.ok) router.push('/');
              }}
            >
              Exit
            </button>
          </>
        ) : (
          <>
            <p className={styles.body} style={{ textAlign: 'center' }}>
              Waiting for {snap.players.find((p) => p.isHost)?.name ?? 'the host'}…
            </p>
            <button
              type="button"
              className={`${styles.button} ${styles.secondary}`}
              disabled={room.pending}
              onClick={async () => {
                const result = await room.act((t) => leaveRoom(t, roomCode));
                if (result.ok) router.push('/');
              }}
            >
              Leave
            </button>
          </>
        )}
      </section>
    </>
  );
}
