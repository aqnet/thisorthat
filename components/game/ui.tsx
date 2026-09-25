'use client';

import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { SnapshotPlayer, StandingRow } from '@/lib/game/snapshot';
import styles from './game.module.css';

export { styles };

export function playerColor(colorSlot: number | null, isComputer = false): string {
  if (isComputer || colorSlot === 0) return 'var(--player-computer)';
  return colorSlot ? `var(--player-${colorSlot})` : 'var(--ink-muted)';
}

/** Colour always travels with an initial, never alone (§13). */
export function PlayerDot({ name, colorSlot, isComputer }: { name: string; colorSlot: number | null; isComputer?: boolean }) {
  return (
    <span className={styles.dot} style={{ background: playerColor(colorSlot, isComputer) }} aria-hidden="true">
      {isComputer ? '⚙' : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function PlayerRow({ player, children, you }: { player: SnapshotPlayer; children?: ReactNode; you?: boolean }) {
  return (
    <div className={`${styles.player} ${player.left ? styles.faded : ''}`}>
      <PlayerDot name={player.name} colorSlot={player.colorSlot} isComputer={player.isComputer} />
      <span className={styles.playerName}>
        {player.name}
        {you ? ' (you)' : ''}
      </span>
      {player.isHost && <span className={`${styles.tag} ${styles.sparkTag}`}>Host</span>}
      {player.isComputer && <span className={styles.tag}>Always here</span>}
      {player.left && <span className={styles.tag}>Left</span>}
      {!player.left && !player.isComputer && !player.connected && <span className={styles.tag}>Reconnecting…</span>}
      {children}
    </div>
  );
}

export function Timer({ seconds }: { seconds: number | null }) {
  if (seconds === null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <span className={`${styles.timer} ${seconds <= 5 ? styles.timerLow : ''}`} role="timer" aria-live="off">
      {m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`}
    </span>
  );
}

export function Toast({ message, onClose }: { message: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  if (!message) return null;
  return (
    <div className={styles.toast} role="status">
      <span>{message}</span>
      <button type="button" className={styles.toastClose} onClick={onClose} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className={styles.sheetBackdrop} onClick={onClose}>
      <div className={styles.sheet} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** QR codes are drawn on the phone from the join URL: no server round trip (§14.1). */
export function QrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { margin: 0, width: 360 }).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [value]);
  // eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing to optimize
  return src ? <img className={styles.qr} src={src} alt={`QR code for ${value}`} /> : <div className={styles.qr} />;
}

export function Scoreboard({ rows, meId, highlight }: { rows: StandingRow[]; meId?: string; highlight?: Record<string, number> | null }) {
  return (
    <div className={styles.stack}>
      {rows.map((row) => (
        <div key={row.playerId} className={`${styles.player} ${row.left ? styles.faded : ''}`}>
          <span className={styles.rank}>{row.rank}</span>
          <PlayerDot name={row.name} colorSlot={row.colorSlot} isComputer={row.isComputer} />
          <span className={styles.playerName}>
            {row.name}
            {row.playerId === meId ? ' (you)' : ''}
          </span>
          {row.left && <span className={styles.tag}>Left</span>}
          {highlight?.[row.playerId] ? (
            <span className={`${styles.tag} ${styles.sparkTag}`}>+{highlight[row.playerId]}</span>
          ) : null}
          <span className={styles.score}>{row.score}</span>
        </div>
      ))}
    </div>
  );
}
