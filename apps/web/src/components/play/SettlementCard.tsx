"use client";

import Link from "next/link";
import { formatTokens, type SettlementVM } from "@/lib/view-model";
import styles from "./SettlementCard.module.css";

interface SettlementCardProps {
  readonly code: string;
  readonly settlement: SettlementVM;
}

export default function SettlementCard({ code, settlement }: SettlementCardProps) {
  const stacks = [...settlement.finalStacks].sort((a, b) => b.net - a.net);

  return (
    <section className={`${styles.card} paper-card`} aria-label="Session settlement">
      <p className={`${styles.eyebrow} num`}>table {code} · cashed out</p>
      <h2 className={styles.title}>The river has spoken</h2>

      <ul className={styles.stacks}>
        {stacks.map((row) => (
          <li key={row.name} className={styles.stackRow}>
            <span className={styles.name}>{row.name}</span>
            <span className={`${styles.stack} num`}>{formatTokens(row.stack)}</span>
            <span
              className={`${styles.net} num ${
                row.net > 0 ? styles.netUp : row.net < 0 ? styles.netDown : styles.netFlat
              }`}
            >
              {row.net > 0 ? "+" : ""}
              {formatTokens(row.net)}
            </span>
          </li>
        ))}
      </ul>

      <div className={styles.owes}>
        <h3 className={styles.owesTitle}>Who owes whom</h3>
        {settlement.pairs.length === 0 ? (
          <p className={styles.owesEmpty}>Dead even. Nobody buys anybody&rsquo;s inference.</p>
        ) : (
          <ul className={styles.owesList}>
            {settlement.pairs.map((pair, index) => (
              <li key={index} className={styles.owesRow}>
                <span className={styles.owesFrom}>{pair.from}</span>
                <span className={styles.owesArrow} aria-hidden>
                  →
                </span>
                <span className={styles.owesTo}>{pair.to}</span>
                <span className={`${styles.owesAmount} num`}>
                  {formatTokens(pair.tokens)} tokens
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.fineprint}>settle in API credits — tokens, not dollars</p>
      </div>

      <Link href="/play" className={`pill ${styles.back}`}>
        Back to lobby
      </Link>
    </section>
  );
}
