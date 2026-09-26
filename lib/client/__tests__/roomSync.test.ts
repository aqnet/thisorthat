/**
 * The logic that keeps a phone's screen current (§14.6). The stale-screen
 * fixes live here: applying snapshots in version order, coalescing refreshes
 * without dropping one, and subscribing without leaking or reusing a channel.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCoalescingRunner, shouldApply, subscribeToRoom, type ChannelLike, type RealtimeLike } from '../roomSync';

describe('shouldApply', () => {
  it('shows newer and same-version snapshots, never older ones', () => {
    expect(shouldApply(-1, 0)).toBe(true);
    expect(shouldApply(5, 6)).toBe(true);
    expect(shouldApply(5, 5)).toBe(true);
    expect(shouldApply(6, 5)).toBe(false);
  });
});

/** A task whose runs the test resolves by hand. */
function controllable() {
  const releases: (() => void)[] = [];
  const task = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
  const finishNext = async () => {
    releases.shift()!();
    // Let the runner's loop observe the finish and possibly start again.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { task, finishNext };
}

describe('createCoalescingRunner', () => {
  it('runs once when nothing else is asked for', async () => {
    const { task, finishNext } = controllable();
    const run = createCoalescingRunner(task);
    const done = run();
    await finishNext();
    await done;
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('turns any number of mid-fetch requests into exactly one more fetch', async () => {
    const { task, finishNext } = controllable();
    const run = createCoalescingRunner(task);
    const first = run();
    // Five broadcasts land while the first fetch is out.
    const bursts = [run(), run(), run(), run(), run()];
    expect(task).toHaveBeenCalledTimes(1);
    await finishNext();
    // The fetch that was running may predate them: one more is owed...
    expect(task).toHaveBeenCalledTimes(2);
    await finishNext();
    await Promise.all([first, ...bursts]);
    // ...and only one.
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('never drops a request that arrives during the catch-up fetch', async () => {
    const { task, finishNext } = controllable();
    const run = createCoalescingRunner(task);
    const first = run();
    void run();
    await finishNext(); // first fetch done; catch-up fetch starts
    void run(); // arrives during the catch-up
    await finishNext();
    expect(task).toHaveBeenCalledTimes(3);
    await finishNext();
    await first;
  });

  it('starts fresh after finishing', async () => {
    const { task, finishNext } = controllable();
    const run = createCoalescingRunner(task);
    const a = run();
    await finishNext();
    await a;
    const b = run();
    await finishNext();
    await b;
    expect(task).toHaveBeenCalledTimes(2);
  });
});

/** A fake of the parts of the Supabase client the subscription uses. */
function fakeClient(existingTopics: string[] = []) {
  const created: FakeChannel[] = [];
  const removed: string[] = [];
  let setAuthRelease: () => void = () => {};
  class FakeChannel implements ChannelLike {
    handlers: ((message: { payload: unknown }) => void)[] = [];
    statusCallback: ((status: string, err?: Error) => void) | null = null;
    constructor(public topic: string) {}
    on(_type: 'broadcast', _filter: { event: string }, callback: (message: { payload: unknown }) => void) {
      this.handlers.push(callback);
      return this;
    }
    subscribe(callback: (status: string, err?: Error) => void) {
      this.statusCallback = callback;
      return this;
    }
  }
  let channels: FakeChannel[] = existingTopics.map((t) => new FakeChannel(t));
  const client: RealtimeLike = {
    realtime: { setAuth: () => new Promise<void>((resolve) => (setAuthRelease = resolve)) },
    getChannels: () => channels,
    removeChannel: async (channel) => {
      removed.push(channel.topic);
      channels = channels.filter((c) => c !== channel);
    },
    channel: (name) => {
      const channel = new FakeChannel(`realtime:${name}`);
      created.push(channel);
      channels.push(channel);
      return channel;
    },
  };
  return { client, created, removed, releaseAuth: () => setAuthRelease() };
}

const handlers = () => ({ onVersion: vi.fn(), onSubscribed: vi.fn(), onFailure: vi.fn() });

describe('subscribeToRoom', () => {
  it('subscribes a private channel for the room and routes broadcasts and status', async () => {
    const fake = fakeClient();
    const h = handlers();
    const pending = subscribeToRoom({ client: fake.client, roomCode: 'KZPW', token: 't', isCancelled: () => false, ...h });
    fake.releaseAuth();
    const channel = await pending;
    expect(channel?.topic).toBe('realtime:room:KZPW');
    const created = fake.created[0];
    created.handlers[0]({ payload: { version: 7 } });
    expect(h.onVersion).toHaveBeenCalledWith(7);
    created.statusCallback!('SUBSCRIBED');
    expect(h.onSubscribed).toHaveBeenCalled();
    created.statusCallback!('CHANNEL_ERROR', new Error('denied'));
    expect(h.onFailure).toHaveBeenCalledWith('CHANNEL_ERROR', expect.any(Error));
  });

  it('creates no channel if the caller went away during the await (no leak)', async () => {
    const fake = fakeClient();
    let cancelled = false;
    const pending = subscribeToRoom({ client: fake.client, roomCode: 'KZPW', token: 't', isCancelled: () => cancelled, ...handlers() });
    cancelled = true; // the effect is torn down while setAuth is in flight
    fake.releaseAuth();
    expect(await pending).toBeNull();
    expect(fake.created).toHaveLength(0);
  });

  it('replaces a leftover channel for the same room instead of reusing it', async () => {
    const fake = fakeClient(['realtime:room:KZPW', 'realtime:room:OTHR']);
    const pending = subscribeToRoom({ client: fake.client, roomCode: 'KZPW', token: 't', isCancelled: () => false, ...handlers() });
    fake.releaseAuth();
    await pending;
    expect(fake.removed).toEqual(['realtime:room:KZPW']);
    expect(fake.created).toHaveLength(1);
    expect(fake.client.getChannels().map((c) => c.topic).sort()).toEqual(['realtime:room:KZPW', 'realtime:room:OTHR']);
  });

  it('treats a broadcast without a version as newer than anything', async () => {
    const fake = fakeClient();
    const h = handlers();
    const pending = subscribeToRoom({ client: fake.client, roomCode: 'KZPW', token: 't', isCancelled: () => false, ...h });
    fake.releaseAuth();
    await pending;
    fake.created[0].handlers[0]({ payload: null });
    expect(h.onVersion).toHaveBeenCalledWith(Infinity);
  });
});
