'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { closeRoom, leaveRoom, removePlayer, setComputerPlayer, setRelaxedTimers, startGame } from '@/app/actions';
import { PlayerRow, QrCode, Sheet, styles } from '@/components/game/ui';
import { accessToken } from '@/lib/client/supabase';
import { MIN_HUMANS, MIN_HUMANS_WITHOUT_COMPUTER } from '@/lib/engine/constants';
import type { PhaseProps } from '../RoomClient';

/** §4-§5: share the room, watch players arrive, host starts at 2+ humans. */
export function Lobby({ snap, room, roomCode }: PhaseProps) {
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [exiting, setExiting] = useState(false);
  const router = useRouter();
  const me = snap.me!;
  const seated = snap.players.filter((p) => !p.isComputer && !p.queued && !p.left);
  const computer = snap.players.find((p) => p.isComputer);
  const missing = Math.max(0, MIN_HUMANS - seated.length);

  // Exit: a player frees their seat; a host hands over to the longest-seated
  // connected player (§6), or closes the room if nobody else is here, so an
  // empty room doesn't sit open until it expires.
  const others = seated.filter((p) => p.id !== me.playerId);
  const nextHost = others.find((p) => p.connected) ?? others[0];
  const closesRoom = me.isHost && others.length === 0;
  const [leaving, setLeaving] = useState(false);
  async function exit() {
    setLeaving(true);
    try {
      // Called directly rather than through room.act: applying the returned
      // snapshot would flash "You were removed" / "The host closed the room"
      // at the person who chose to leave, before Home loads.
      const token = await accessToken();
      const result = closesRoom ? await closeRoom(token, roomCode) : await leaveRoom(token, roomCode);
      if (result.ok) {
        router.push('/');
        return;
      }
      setExiting(false);
      setLeaving(false);
      room.notify(result.message);
    } catch {
      setExiting(false);
      setLeaving(false);
      room.notify("Couldn't reach the game. Try again.");
    }
  }
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
        {computer && <PlayerRow player={computer} sittingOut={!snap.computerPlays} />}
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
              onChange={(e) => {
                // Read the value now: this is a controlled input, and by the
                // time the action's callback runs React has reset it.
                const relaxed = e.target.checked;
                void room.act((t) => setRelaxedTimers(t, roomCode, relaxed));
              }}
              style={{ width: 24, height: 24 }}
            />
          </label>
          {/* §5: the Computer can sit out only with 3+ humans; below that it always plays. */}
          <label className={styles.spread}>
            <span>
              <strong>Computer player</strong>
              <br />
              <span className={styles.hint}>
                {seated.length < MIN_HUMANS_WITHOUT_COMPUTER
                  ? `Always plays with fewer than ${MIN_HUMANS_WITHOUT_COMPUTER} players`
                  : snap.computerPlays
                    ? 'Adds one item to every ballot. Switch off to play humans only.'
                    : 'Sitting out: humans only this game.'}
              </span>
            </span>
            <input
              type="checkbox"
              checked={snap.computerPlays}
              disabled={room.pending || seated.length < MIN_HUMANS_WITHOUT_COMPUTER}
              onChange={(e) => {
                const plays = e.target.checked; // read now; see the relaxed-timers switch
                void room.act((t) => setComputerPlayer(t, roomCode, plays));
              }}
              style={{ width: 24, height: 24 }}
              aria-label="Computer player"
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

      <button
        type="button"
        className={`${styles.button} ${styles.secondary}`}
        disabled={room.pending}
        onClick={() => setExiting(true)}
      >
        Exit
      </button>

      <Sheet open={exiting} onClose={() => setExiting(false)}>
        <p className={styles.title} style={{ fontSize: 28 }}>
          Exit to the home screen?
        </p>
        <p className={styles.body}>
          {closesRoom
            ? `Nobody else is here, so room ${roomCode} will close.`
            : me.isHost
              ? `${nextHost?.name ?? 'The next player'} becomes the host, and the room carries on without you.`
              : 'Your seat opens up for someone else. You can join again with the code.'}
        </p>
        <button type="button" className={styles.button} disabled={leaving} onClick={exit}>
          {leaving ? 'Exiting…' : 'Yes, exit'}
        </button>
        <button type="button" className={styles.ghost} onClick={() => setExiting(false)}>
          Stay
        </button>
      </Sheet>

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
