/**
 * Deterministic RNG. The server stores a per-game seed (games.rng_seed) so any
 * shuffle or Computer pick can be replayed when debugging a game (spec §14.8).
 *
 * This is NOT for room codes or ballot card ids -- those need a CSPRNG and are
 * generated outside the engine.
 */

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, max). */
  int(max: number): number;
  /** Fisher-Yates. Returns a new array; never mutates the input. */
  shuffle<T>(items: readonly T[]): T[];
  /** One weighted draw. Weights must be non-negative and not all zero. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
}

/** mulberry32: small, fast, and good enough for game shuffles. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (max: number): number => {
    if (max <= 0) throw new Error('rng.int requires max > 0');
    return Math.floor(next() * max);
  };

  return {
    next,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    weighted<T>(items: readonly T[], weight: (item: T) => number): T {
      if (items.length === 0) throw new Error('rng.weighted requires a non-empty list');
      const weights = items.map((item) => {
        const w = weight(item);
        if (!Number.isFinite(w) || w < 0) throw new Error('weights must be finite and >= 0');
        return w;
      });
      const total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) return items[int(items.length)];

      let roll = next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i];
        if (roll < 0) return items[i];
      }
      return items[items.length - 1];
    },
  };
}

/** Derive a numeric seed from the stored bytea seed. */
export function seedFromBytes(bytes: Uint8Array): number {
  let h = 2166136261 >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
