/**
 * The logic behind useRoom that keeps a phone's screen current (§14.6),
 * kept free of React so it can be unit-tested. useRoom wires it to state.
 */

/** Show a snapshot only if nothing newer is already on screen. */
export function shouldApply(currentVersion: number, nextVersion: number): boolean {
  return nextVersion >= currentVersion;
}

/**
 * Coalesce refreshes: while one fetch is running, any number of further
 * requests cost exactly ONE more fetch afterwards -- a request that arrives
 * mid-fetch may be for a newer version than the one in flight, so it can't be
 * dropped, but a burst of broadcasts shouldn't cost a fetch each.
 */
export function createCoalescingRunner(task: () => Promise<void>): () => Promise<void> {
  let inflight: Promise<void> | null = null;
  let again = false;
  return function run() {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/** The parts of the Supabase client the room subscription uses. */
export interface ChannelLike {
  topic: string;
  on(type: 'broadcast', filter: { event: string }, callback: (message: { payload: unknown }) => void): ChannelLike;
  subscribe(callback: (status: string, err?: Error) => void): ChannelLike;
}

export interface RealtimeLike {
  realtime: { setAuth(token: string): Promise<void> };
  getChannels(): ChannelLike[];
  removeChannel(channel: ChannelLike): Promise<unknown>;
  channel(name: string, options: { config: { private: boolean } }): ChannelLike;
}

export interface SubscribeOptions {
  client: RealtimeLike;
  roomCode: string;
  token: string;
  /** True once the component that asked has gone away. */
  isCancelled: () => boolean;
  onVersion: (version: number) => void;
  onSubscribed: () => void;
  onFailure: (status: string, err?: Error) => void;
}

/**
 * Subscribe to a room's private channel.
 *
 * Two traps this avoids:
 *  - The caller can be torn down while we await (React runs effects twice in
 *    development). Subscribing after that leaks a channel nothing removes, so
 *    cancellation is re-checked after every await.
 *  - supabase.channel() REUSES an existing channel for the same topic. A
 *    leftover one -- possibly already closed -- would come back, and
 *    subscribing it twice fails, leaving the phone without live updates. Any
 *    leftover is removed first, so the channel is always fresh.
 *
 * Returns the channel, or null if cancelled.
 */
export async function subscribeToRoom(options: SubscribeOptions): Promise<ChannelLike | null> {
  const { client, roomCode, token, isCancelled } = options;
  await client.realtime.setAuth(token);
  if (isCancelled()) return null;
  const topic = `realtime:room:${roomCode}`;
  for (const stale of client.getChannels().filter((c) => c.topic === topic)) {
    await client.removeChannel(stale);
  }
  if (isCancelled()) return null;
  return client
    .channel(`room:${roomCode}`, { config: { private: true } })
    .on('broadcast', { event: 'state' }, ({ payload }) => {
      options.onVersion((payload as { version?: number } | null)?.version ?? Infinity);
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') options.onSubscribed();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') options.onFailure(status, err);
    });
}
