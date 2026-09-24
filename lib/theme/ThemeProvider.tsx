'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  STORAGE_KEY,
  isMode,
  isTheme,
  type ModeName,
  type ThemeName,
} from './themes';

interface ThemeSetting {
  theme: ThemeName;
  mode: ModeName;
}

interface ThemeContextValue extends ThemeSetting {
  setTheme: (theme: ThemeName) => void;
  setMode: (mode: ModeName) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DEFAULTS: ThemeSetting = { theme: DEFAULT_THEME, mode: DEFAULT_MODE };
const CHANGE_EVENT = 'tot:theme-change';

/**
 * localStorage is an external store, so it is read through
 * useSyncExternalStore rather than copied into state inside an effect. That
 * keeps the server render and the hydration pass consistent, and React
 * re-renders once on the client with the real stored value.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // `storage` fires for other tabs; the custom event covers this one.
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

// Cached so getSnapshot returns a stable reference; React would otherwise
// loop on a fresh object every render.
let snapshot: ThemeSetting = DEFAULTS;

function readStored(): ThemeSetting {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as { theme?: unknown; mode?: unknown };
    return {
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_THEME,
      mode: isMode(parsed.mode) ? parsed.mode : DEFAULT_MODE,
    };
  } catch {
    // Private browsing, blocked site data: the defaults still work.
    return DEFAULTS;
  }
}

function getSnapshot(): ThemeSetting {
  const next = readStored();
  if (next.theme !== snapshot.theme || next.mode !== snapshot.mode) snapshot = next;
  return snapshot;
}

function getServerSnapshot(): ThemeSetting {
  return DEFAULTS;
}

/**
 * Applies the theme as attributes on <html>. A theme swap is attribute-only,
 * with no layout re-render: the token blocks in globals.css do the rest (§14.1).
 */
function applyToDocument({ theme, mode }: ThemeSetting): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // "system" means no attribute at all, so prefers-color-scheme decides.
  if (mode === 'system') root.removeAttribute('data-mode');
  else root.setAttribute('data-mode', mode);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const setting = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const write = useCallback((next: ThemeSetting) => {
    applyToDocument(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // A theme that doesn't persist is still a theme that works this session.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
    for (const listener of listeners) listener();
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      ...setting,
      setTheme: (theme: ThemeName) => write({ ...setting, theme }),
      setMode: (mode: ModeName) => write({ ...setting, mode }),
    }),
    [setting, write],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
