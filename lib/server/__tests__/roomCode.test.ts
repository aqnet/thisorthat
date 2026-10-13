/**
 * §4 room codes are unique among open rooms. Two rooms drawing the same code
 * is a race the database settles with its unique index; the runner then
 * draws again. Replayed here by fixing the random draws, on PGlite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './harness';

const draws = vi.hoisted(() => ({ queue: [] as number[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    // Room codes draw letter by letter; queued values replay a collision.
    randomInt: (max: number) => (draws.queue.length ? draws.queue.shift()! : actual.randomInt(max)),
  };
});

let h: Harness;
let runner: typeof import('../runner');

beforeAll(async () => {
  h = await startHarness();
  runner = await import('../runner');
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe('§4 room code collisions', () => {
  it('draws again when a new room lands on an open room’s code', async () => {
    // A = 0, B = 1 in the room-code alphabet.
    draws.queue.push(0, 0, 0, 0); // first room: AAAA
    const first = await runner.createRoom(await h.newUser(), 'Ana');
    expect(first.roomCode).toBe('AAAA');

    draws.queue.push(0, 0, 0, 0, 1, 1, 1, 1); // AAAA again (taken), then BBBB
    const second = await runner.createRoom(await h.newUser(), 'Ben');
    expect(second.roomCode).toBe('BBBB');
    expect(draws.queue).toEqual([]);
  });

  it('reuses a closed room’s code', async () => {
    const [{ id }] = await h.admin((s) => s`select id from this_or_that.sessions where room_code = 'AAAA'`);
    await h.admin((s) => s`update this_or_that.sessions set status = 'closed', closed_at = now() where id = ${id}`);
    draws.queue.push(0, 0, 0, 0);
    expect((await runner.createRoom(await h.newUser(), 'Cy')).roomCode).toBe('AAAA');
  });
});
