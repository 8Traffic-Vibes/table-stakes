"use client";

import { useState } from "react";
import styles from "./JoinSheet.module.css";

interface JoinSheetProps {
  readonly code: string;
  readonly phase: "waiting" | "playing" | "ended" | null;
  readonly onJoin: (name: string) => Promise<{ ok: boolean; error?: string }>;
  readonly onSpectate: () => void;
}

export default function JoinSheet({ code, phase, onJoin, onSpectate }: JoinSheetProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const midSession = phase === "playing";
  const blocked = error !== null && /full|progress|over/.test(error);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    const result = await onJoin(name);
    if (!result.ok) {
      setError(result.error ?? "could not sit you down");
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop}>
      <section className={`${styles.sheet} paper-card`} aria-label="Take a seat">
        <h2 className={styles.title}>Take a seat</h2>
        <p className={styles.sub}>
          Table <span className={`${styles.code} num`}>{code}</span> · buy-in on the house,
          losses on your API bill.
        </p>
        {midSession && (
          <p className={styles.note}>They&rsquo;re mid-session — seats open between hands.</p>
        )}
        <form className={styles.form} onSubmit={handleSubmit}>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="your name"
            maxLength={24}
            autoComplete="nickname"
            aria-label="Your name"
          />
          <button className="pill" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Pulling up a chair…" : "Sit down"}
          </button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
        {blocked && (
          <p className={styles.note}>No seat right now — you can still watch the carnage.</p>
        )}
        <button type="button" className={`pill pill--ghost ${styles.ghost}`} onClick={onSpectate}>
          Just watch
        </button>
      </section>
    </div>
  );
}
