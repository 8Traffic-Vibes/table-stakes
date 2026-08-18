"use client";

import { useState } from "react";
import { formatTokens, type SeatVM } from "@/lib/view-model";
import styles from "./WaitingPanel.module.css";

interface WaitingPanelProps {
  readonly code: string;
  readonly seats: readonly SeatVM[];
  readonly maxSeats: number;
  readonly seated: boolean;
  readonly onStart: () => Promise<void>;
  readonly onCopyLink: () => void;
}

export default function WaitingPanel({
  code,
  seats,
  maxSeats,
  seated,
  onStart,
  onCopyLink,
}: WaitingPanelProps) {
  const [starting, setStarting] = useState(false);
  const enough = seats.length >= 2;

  const handleStart = async (): Promise<void> => {
    if (starting) return;
    setStarting(true);
    await onStart();
    setStarting(false);
  };

  return (
    <section className={`${styles.panel} paper-card`} aria-label="Waiting for players">
      <h2 className={styles.title}>The table is set</h2>
      <p className={styles.sub}>
        Send the code to your table — {seats.length} of {maxSeats} seats taken.
      </p>

      <button type="button" className={styles.codeRow} onClick={onCopyLink}>
        <span className={`${styles.code} num`}>{code}</span>
        <span className={styles.codeHint}>tap to copy the invite link</span>
      </button>

      <ul className={styles.list}>
        {seats.map((seat) => (
          <li key={seat.playerId} className={styles.player}>
            <span className={styles.playerDot} aria-hidden />
            <span className={styles.playerName}>{seat.name}</span>
            <span className={`${styles.playerStack} num`}>{formatTokens(seat.stack)}</span>
          </li>
        ))}
      </ul>

      {seated ? (
        <>
          <button
            type="button"
            className={`pill ${styles.start}`}
            onClick={() => void handleStart()}
            disabled={starting || !enough}
          >
            {starting ? "Dealing…" : "Start the game"}
          </button>
          <p className={styles.hostHint}>
            {enough ? "host only — first seat runs the room" : "need at least 2 players"}
          </p>
        </>
      ) : (
        <p className={styles.hostHint}>grab a seat to play — or lurk, we don&rsquo;t judge</p>
      )}
    </section>
  );
}
