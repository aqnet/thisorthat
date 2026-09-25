'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { joinRoom, lookupRoom, rejoinSeat } from '@/app/actions';
import { styles } from '@/components/game/ui';
import { accessToken } from '@/lib/client/supabase';
import type { JoinInfo } from '@/lib/game/snapshot';

/**
 * §5 join and §6 errors. Every failed join lands on a screen with a clear
 * next step, and a disconnected seat can be reclaimed from a new device.
 */
export function JoinClient({ roomCode }: { roomCode: string }) {
  const router = useRouter();
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryCode, setRetryCode] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const result = await lookupRoom(await accessToken(), roomCode);
        if (!live) return;
        if (!result.ok) return setLoadError(result.message);
        if (result.info.status === 'seated') return router.replace(`/room/${roomCode}`);
        setInfo(result.info);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : "Couldn't reach the game");
      }
    })();
    return () => {
      live = false;
    };
  }, [roomCode, router]);

  async function onJoin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await joinRoom(await accessToken(), roomCode, name);
      if (result.ok) router.push(`/room/${roomCode}`);
      else if (result.code === 'room_full') setInfo((i) => (i ? { ...i, status: 'full' } : i));
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRejoin(playerId: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await rejoinSeat(await accessToken(), roomCode, playerId);
      if (result.ok) router.push(`/room/${roomCode}`);
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <h1 className={styles.title}>Can&apos;t connect</h1>
        <p className={styles.body}>{loadError}</p>
        <Link href="/" className={`${styles.button} ${styles.secondary}`}>
          Home
        </Link>
      </main>
    );
  }

  if (!info) {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <p className={styles.body}>Finding room {roomCode}…</p>
      </main>
    );
  }

  if (info.status === 'not_found') {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <h1 className={styles.title}>Room not found</h1>
        <p className={styles.body}>Check the code with the host. Rooms expire after 2 hours without play.</p>
        <form
          className={styles.stack}
          style={{ width: '100%' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (retryCode.length === 4) router.push(`/join/${retryCode}`);
          }}
        >
          <input
            className={`${styles.input} ${styles.codeInput}`}
            value={retryCode}
            onChange={(e) => setRetryCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
            placeholder="CODE"
            aria-label="Room code"
            autoCapitalize="characters"
          />
          <button className={styles.button} disabled={retryCode.length !== 4}>
            Try again
          </button>
        </form>
        <Link href="/" className={`${styles.button} ${styles.secondary}`}>
          New Game
        </Link>
      </main>
    );
  }

  if (info.status === 'closed') {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <h1 className={styles.title}>This room was closed</h1>
        <p className={styles.body}>The host closed room {roomCode}.</p>
        <Link href="/" className={styles.button}>
          Start your own
        </Link>
        <Link href="/" className={`${styles.button} ${styles.secondary}`}>
          Home
        </Link>
      </main>
    );
  }

  if (info.status === 'full') {
    return (
      <main className={`${styles.screen} ${styles.center}`}>
        <h1 className={styles.title}>Room is full</h1>
        <p className={styles.body}>Room {roomCode} already has 4 players.</p>
        <Link href="/" className={styles.button}>
          Start your own
        </Link>
        <Link href="/" className={`${styles.button} ${styles.secondary}`}>
          Home
        </Link>
      </main>
    );
  }

  const inProgress = info.status === 'in_progress';
  return (
    <main className={styles.screen}>
      <div className={styles.topbar}>
        <Link href="/" className={styles.ghost}>
          ← Home
        </Link>
        <span className={styles.eyebrow}>Room {roomCode}</span>
      </div>

      <h1 className={styles.title}>{inProgress ? 'Game in progress' : 'Join the game'}</h1>
      {inProgress && (
        <p className={styles.body}>You&apos;ll join the next game. Enter your name now and watch the scores while you wait.</p>
      )}

      {info.rejoinable.length > 0 && (
        <section className={styles.panel}>
          <p className={styles.eyebrow}>Were you playing?</p>
          {info.rejoinable.map((seat) => (
            <button
              key={seat.playerId}
              type="button"
              className={`${styles.button} ${styles.secondary}`}
              disabled={busy}
              onClick={() => onRejoin(seat.playerId)}
            >
              Rejoin as {seat.name}
            </button>
          ))}
        </section>
      )}

      <form className={styles.stack} onSubmit={onJoin}>
        <label className={styles.stack}>
          <span className={styles.hint}>Your name</span>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={12}
            autoFocus
            autoComplete="nickname"
            placeholder="Up to 12 letters"
          />
        </label>
        {error && <p className={styles.error}>{error}</p>}
        <button className={styles.button} disabled={busy || !name.trim()}>
          {busy ? 'Joining…' : inProgress ? 'Join the next game' : 'Join'}
        </button>
      </form>
      <Link href="/" className={styles.ghost} style={{ textAlign: 'center' }}>
        Start your own instead
      </Link>
    </main>
  );
}
