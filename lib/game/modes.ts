import type { GameMode } from '@/lib/engine/types';

/** Mode spec §1: names in sentence case everywhere, and the picker's pitch. */
export const MODE_INFO: Record<GameMode, { name: string; pitch: string }> = {
  pick_your_fav: { name: 'Pick your fav', pitch: 'Every round is a fresh ballot.' },
  pick_and_fwd: { name: 'Pick and fwd', pitch: 'Round winners stay on the ballot until someone beats them.' },
};

export const MODE_ORDER: GameMode[] = ['pick_your_fav', 'pick_and_fwd'];
