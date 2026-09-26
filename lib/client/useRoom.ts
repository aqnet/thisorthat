'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSnapshot, heartbeat } from '@/app/actions';
import { HEARTBEAT_INTERVAL_MS } from '@/lib/engine/constants';
import type { ActionResult, RoomSnapshot } from '@/lib/game/snapshot';
import { createCoalescingRunner, shouldApply, subscribeToRoom, type RealtimeLike } from './roomSync';
import { accessToken, supabase } from './supabase';

/**
 * A room's live state on this phone (§14.6).
 *
 * Broadcasts say only "the room is at version N"; the phone then fetches its
 * own snapshot, which is the one place private state (your list, your vote)
 * can come from. The heartbeat doubles as a safety net: it returns the room's
 * version, so a missed broadcast is noticed within 10 seconds.
 */
export function useRoom(roomCode: string) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const versionRef = useRef(-1);

  /** Show a snapshot unless a newer one is already on screen. */
  const apply = useCallback((next: RoomSnapshot) => {
    if (!shouldApply(versionRef.current, next.version)) return;
    versionRef.current = next.version;
    // §14.3.6: render deadlines against the server's clock, not the phone's.
    setOffset(next.serverNow - Date.now());
    setSnapshot(next);
    setError(null);
  }, []);

  const fetchSnapshot = useCallback(async () => {
    try {
      const token = await accessToken();
      const result = await getSnapshot(token, roomCode);
      if (!result.ok) {
        if (result.code === 'not_found') setNotFound(true);
        else setError(result.message);
        // Once a room is on screen these errors aren't shown, so the screen
        // just stops updating. Leave a trace for whoever is debugging it.
        console.warn(`[room] snapshot refresh failed for ${roomCode}: ${result.message}`);
        return;
      }
      apply(result.snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach the game");
      console.warn(`[room] snapshot refresh failed for ${roomCode}:`, e);
    }
  }, [roomCode, apply]);

  // A burst of broadcasts costs one fetch, and a request mid-fetch one more.
  // Built on first use, and always calls the latest fetch through a ref.
  const fetchRef = useRef(fetchSnapshot);
  useEffect(() => {
    fetchRef.current = fetchSnapshot;
  }, [fetchSnapshot]);
  const runner = useRef<(() => Promise<void>) | null>(null);
  const refresh = useCallback(() => {
    runner.current ??= createCoalescingRunner(() => fetchRef.current());
    return runner.current();
  }, []);

  // First load, Realtime subscription, heartbeat.
  useEffect(() => {
    let cancelled = false;
    let channel: Awaited<ReturnType<typeof subscribeToRoom>> = null;
    // Deferred so the first fetch doesn't set state inside the effect body.
    const first = setTimeout(() => void refresh(), 0);

    (async () => {
      const token = await accessToken().catch(() => null);
      if (!token || cancelled) return;
      channel = await subscribeToRoom({
        client: supabase() as unknown as RealtimeLike,
        roomCode,
        token,
        isCancelled: () => cancelled,
        onVersion: (version) => {
          if (version > versionRef.current) void refresh();
        },
        // Anything broadcast between the first fetch and now was missed.
        onSubscribed: () => void refresh(),
        // Without Realtime the room still works, catching up on each
        // heartbeat -- but every screen lags by up to 10s. Say so.
        onFailure: (status, err) =>
          console.warn(`[room] realtime ${status} for room:${roomCode}`, err?.message ?? ''),
      });
    })();

    const beat = async () => {
      try {
        const token = await accessToken();
        const result = await heartbeat(token, roomCode);
        if (result.ok && result.version !== versionRef.current) void refresh();
      } catch {
        // A missed heartbeat is fine; the next one or a broadcast catches up.
      }
    };
    void beat();
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void beat();
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (channel) void (supabase() as unknown as RealtimeLike).removeChannel(channel);
    };
  }, [roomCode, refresh]);

  // When a deadline passes, the server advances within ~1s. If the broadcast
  // doesn't arrive, poll briefly so the phone never sits on "Time's up".
  useEffect(() => {
    const deadline = snapshot?.phaseDeadline;
    if (!deadline) return;
    const version = snapshot.version;
    let poll: ReturnType<typeof setInterval> | null = null;
    const wait = setTimeout(
      () => {
        poll = setInterval(() => {
          if (versionRef.current === version) void refresh();
          else if (poll) clearInterval(poll);
        }, 1500);
      },
      Math.max(0, deadline - (Date.now() + offset)) + 2000,
    );
    return () => {
      clearTimeout(wait);
      if (poll) clearInterval(poll);
    };
  }, [snapshot?.phaseDeadline, snapshot?.version, offset, refresh]);

  /** Run a Server Action as this device, then pull the new state. */
  const act = useCallback(
    async <T extends object>(fn: (token: string) => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
      setPending(true);
      try {
        const token = await accessToken();
        const result = await fn(token);
        if (!result.ok) setToast(result.message);
        // Actions return the caller's fresh view; apply it at once. The
        // broadcast still updates everyone else.
        else if ('snapshot' in result && result.snapshot) apply(result.snapshot as RoomSnapshot);
        else void refresh();
        return result;
      } catch {
        const message = "Couldn't reach the game. Try again.";
        setToast(message);
        return { ok: false, message };
      } finally {
        setPending(false);
      }
    },
    [refresh, apply],
  );

  const serverNow = useCallback(() => Date.now() + offset, [offset]);
  const clearToast = useCallback(() => setToast(null), []);
  /** Show a message in the room's toast, for flows that bypass `act`. */
  const notify = useCallback((message: string) => setToast(message), []);

  return {
    snapshot,
    error,
    notFound,
    pending,
    toast,
    clearToast,
    notify,
    act,
    apply,
    refresh,
    serverNow,
  };
}

/** Whole seconds left until a server-clock deadline, ticking. */
export function useCountdown(deadline: number | null, serverNow: () => number): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (deadline === null) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - serverNow()) / 1000)));
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 250);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [deadline, serverNow]);
  return deadline === null ? null : left;
}
