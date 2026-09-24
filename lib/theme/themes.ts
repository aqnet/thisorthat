/** Theme and mode are two independent settings, stored per device (§2). */

export const THEMES = ['duel', 'candy'] as const;
export type ThemeName = (typeof THEMES)[number];

export const MODES = ['light', 'dark', 'system'] as const;
export type ModeName = (typeof MODES)[number];

export const DEFAULT_THEME: ThemeName = 'duel';
export const DEFAULT_MODE: ModeName = 'system';

export const THEME_LABELS: Record<ThemeName, string> = {
  duel: 'Duel',
  candy: 'Candy Pop',
};

export const THEME_BLURBS: Record<ThemeName, string> = {
  duel: 'Bold and poster-like, with versus energy.',
  candy: 'Rounded and playful, on floating cards.',
};

/** Layout is limited to variants the choice component supports (§2). */
export const THEME_LAYOUT: Record<ThemeName, 'split' | 'cards'> = {
  duel: 'split',
  candy: 'cards',
};

export const STORAGE_KEY = 'tot.theme';

export function isTheme(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function isMode(value: unknown): value is ModeName {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}
