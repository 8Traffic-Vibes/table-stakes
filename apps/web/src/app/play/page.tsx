"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createRoom, joinRoom } from "@/lib/human-client";
import styles from "./page.module.css";

const CODE_LENGTH = 5;
const cleanCode = (raw: string): string =>
  raw.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, CODE_LENGTH);

export default function PlayLobbyPage() {
  const router = useRouter();

  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const handleCreate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (creating || !createName.trim()) return;
    setCreating(true);
    setCreateError(null);
    const result = await createRoom(createName);
    if (result.ok) {
      router.push(`/play/${result.roomId}`);
      return;
    }
    setCreateError(result.error);
    setCreating(false);
  };

  const handleJoin = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (joining || joinCode.length !== CODE_LENGTH || !joinName.trim()) return;
    setJoining(true);
    setJoinError(null);
    const result = await joinRoom(joinCode, joinName);
    if (result.ok) {
      router.push(`/play/${joinCode}`);
      return;
    }
    setJoinError(result.error);
    setJoining(false);
  };

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <Link href="/" className={styles.wordmark}>
          Table Stakes
        </Link>
        <span className={`${styles.blindsNote} num`}>blinds 1k/2k — tokens, not dollars</span>
      </header>

      <h1 className={styles.headline}>Pull up a chair</h1>
      <p className={styles.sub}>
        No-limit hold&rsquo;em for your group chat. Six seats, thirty-second clock, and the
        chips are LLM tokens.
      </p>

      <section className={`${styles.card} paper-card`}>
        <h2 className={styles.cardTitle}>Start a table</h2>
        <form className={styles.form} onSubmit={handleCreate}>
          <input
            className={styles.input}
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder="your name"
            maxLength={24}
            autoComplete="nickname"
            aria-label="Your name"
          />
          <button className="pill" type="submit" disabled={creating || !createName.trim()}>
            {creating ? "Shuffling…" : "Deal me in"}
          </button>
          {createError && <p className={styles.error}>{createError}</p>}
        </form>
        <p className={styles.hint}>You get a 5-letter code to send to your table.</p>
      </section>

      <section className={`${styles.card} paper-card`}>
        <h2 className={styles.cardTitle}>Join a table</h2>
        <form className={styles.form} onSubmit={handleJoin}>
          <input
            className={`${styles.input} ${styles.codeInput} num`}
            value={joinCode}
            onChange={(event) => setJoinCode(cleanCode(event.target.value))}
            placeholder="CODE"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Room code"
          />
          <input
            className={styles.input}
            value={joinName}
            onChange={(event) => setJoinName(event.target.value)}
            placeholder="your name"
            maxLength={24}
            autoComplete="nickname"
            aria-label="Your name"
          />
          <button
            className="pill"
            type="submit"
            disabled={joining || joinCode.length !== CODE_LENGTH || !joinName.trim()}
          >
            {joining ? "Pulling up a chair…" : "Take a seat"}
          </button>
          {joinError && <p className={styles.error}>{joinError}</p>}
        </form>
      </section>

      <section className={styles.how} aria-label="How it works">
        <div className={`${styles.chip} ${styles.chipPeach}`}>
          <span className={styles.chipTitle}>Chips are LLM tokens</span>
          <span className={styles.chipBody}>Every chip is 1,000 tokens of real inference.</span>
        </div>
        <div className={`${styles.chip} ${styles.chipMint}`}>
          <span className={styles.chipTitle}>Provably-fair deals</span>
          <span className={styles.chipBody}>Each deck is committed before a card moves.</span>
        </div>
        <div className={`${styles.chip} ${styles.chipLavender}`}>
          <span className={styles.chipTitle}>Loser owes inference</span>
          <span className={styles.chipBody}>Settle in API credits. Bragging rights included.</span>
        </div>
      </section>
    </main>
  );
}
