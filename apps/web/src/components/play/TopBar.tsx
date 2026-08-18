"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatTokens } from "@/lib/view-model";
import styles from "./TopBar.module.css";

interface TopBarProps {
  readonly code: string;
  readonly handNo: number;
  readonly blinds: { readonly small: number; readonly big: number } | null;
  readonly connected: boolean;
  readonly seated: boolean;
  readonly spectating: boolean;
  readonly onCopyLink: () => void;
  readonly onEndSession: () => void;
}

export default function TopBar({
  code,
  handNo,
  blinds,
  connected,
  seated,
  spectating,
  onCopyLink,
  onEndSession,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  return (
    <header className={styles.bar}>
      <button
        type="button"
        className={`${styles.code} num`}
        onClick={onCopyLink}
        aria-label={`Room ${code} — copy share link`}
      >
        {code}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>

      <div className={styles.middle}>
        {handNo > 0 && <span className={`${styles.stat} num`}>hand #{handNo}</span>}
        {blinds && (
          <span className={`${styles.stat} num`} title="Blinds — tokens, not dollars">
            {formatTokens(blinds.small)}/{formatTokens(blinds.big)}
          </span>
        )}
        {spectating && <span className={styles.watching}>watching</span>}
      </div>

      <div className={styles.right} ref={menuRef}>
        <span
          className={`${styles.dot} ${connected ? styles.dotOn : styles.dotOff}`}
          title={connected ? "connected" : "reconnecting…"}
          aria-label={connected ? "connected" : "reconnecting"}
        />
        <button
          type="button"
          className={styles.menuBtn}
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Table menu"
          aria-expanded={menuOpen}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
        {menuOpen && (
          <div className={styles.menu}>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                setMenuOpen(false);
                onCopyLink();
              }}
            >
              Copy invite link
            </button>
            <Link href="/play" className={styles.menuItem}>
              Back to lobby
            </Link>
            {seated && (
              <button
                type="button"
                className={`${styles.menuItem} ${styles.menuDanger}`}
                onClick={() => {
                  setMenuOpen(false);
                  onEndSession();
                }}
              >
                End session
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
