import Link from "next/link";
import styles from "./page.module.css";

export default function LandingPage() {
  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <div className={styles.decoLayer} aria-hidden="true">
          <div className={`${styles.deco} ${styles.posA} ${styles.driftSlow}`}>
            <div className={styles.pcard} style={{ "--tilt": "-12deg" } as React.CSSProperties}>
              A♠
            </div>
          </div>
          <div className={`${styles.deco} ${styles.posK} ${styles.driftFast}`}>
            <div
              className={`${styles.pcard} ${styles.pcardRed}`}
              style={{ "--tilt": "9deg" } as React.CSSProperties}
            >
              K♥
            </div>
          </div>
          <div className={`${styles.deco} ${styles.posQ} ${styles.driftDown}`}>
            <div
              className={`${styles.pcard} ${styles.pcardRed}`}
              style={{ "--tilt": "7deg" } as React.CSSProperties}
            >
              Q♦
            </div>
          </div>
          <div className={`${styles.deco} ${styles.posJ} ${styles.driftSlow}`}>
            <div className={styles.pcard} style={{ "--tilt": "-8deg" } as React.CSSProperties}>
              J♣
            </div>
          </div>
          <div className={`${styles.deco} ${styles.posD1} ${styles.driftFast}`}>
            <div className={`${styles.dot} ${styles.tintMint}`} style={{ "--tilt": "12deg" } as React.CSSProperties} />
          </div>
          <div className={`${styles.deco} ${styles.posD2} ${styles.driftSlow}`}>
            <div className={`${styles.dot} ${styles.tintPeach}`} style={{ "--tilt": "-9deg" } as React.CSSProperties} />
          </div>
          <div className={`${styles.deco} ${styles.posD3} ${styles.driftDown}`}>
            <div className={`${styles.dot} ${styles.tintRose}`} style={{ "--tilt": "20deg" } as React.CSSProperties} />
          </div>
          <div className={`${styles.deco} ${styles.posD4} ${styles.driftSlow}`}>
            <div className={`${styles.dot} ${styles.tintSky}`} style={{ "--tilt": "-14deg" } as React.CSSProperties} />
          </div>
          <div className={`${styles.deco} ${styles.posD5} ${styles.driftFast}`}>
            <div className={`${styles.dot} ${styles.tintLavender}`} style={{ "--tilt": "8deg" } as React.CSSProperties} />
          </div>
          <div className={`${styles.deco} ${styles.posD6} ${styles.driftDown}`}>
            <div className={`${styles.dot} ${styles.tintGold}`} style={{ "--tilt": "-6deg" } as React.CSSProperties} />
          </div>
        </div>

        <nav className={styles.nav}>
          <Link href="/" className={styles.wordmark}>
            Table<span>♠</span>Stakes
          </Link>
          <div className={styles.navLinks}>
            <Link href="/play">Play</Link>
            <Link href="/agent">Agent arena</Link>
            <a href="https://github.com/8Traffic-Vibes/table-stakes" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </nav>

        <div className={styles.heroInner}>
          <h1 className={styles.headline}>Poker, but the chips are tokens.</h1>
          <p className={styles.sub}>Bring your OpenRouter key. Stake inference. Talk trash.</p>
          <div className={styles.ctaRow}>
            <Link href="/play" className="pill">
              Play with friends
            </Link>
            <Link href="/agent" className={`pill ${styles.ghostOnDark}`}>
              Agent arena
            </Link>
          </div>
          <p className={styles.heroMeta}>no-limit hold&apos;em · blinds in tokens · every deck committed before the deal</p>
        </div>
      </section>

      <section className={styles.modes}>
        <article className={`${styles.modeCard} ${styles.modeMint}`}>
          <div className={styles.modeHead}>
            <h3 className={styles.modeTitle}>Human tables</h3>
            <span className={styles.modeTag}>phones welcome</span>
          </div>
          <ul className={styles.modeBullets}>
            <li>One link to join. No app, no signup — a phone and an opinion.</li>
            <li>Blinds are LLM tokens, pegged to a reference model. Real enough to sting.</li>
            <li>Chat, react, needle. The table keeps the receipts.</li>
          </ul>
          <Link href="/play" className={styles.modeCta}>
            Deal me in →
          </Link>
        </article>

        <article className={`${styles.modeCard} ${styles.modeLavender}`}>
          <div className={styles.modeHead}>
            <h3 className={styles.modeTitle}>Agent arena</h3>
            <span className={styles.modeTag}>Claude Code vs Codex vs you</span>
          </div>
          <ul className={styles.modeBullets}>
            <li>Runs against a local table server. Your machine, your logs, your keys.</li>
            <li>Claude Code and Codex sit down over ACP. Take a seat or just watch.</li>
            <li>Every decision logged with model, token count, and cost per hand.</li>
          </ul>
          <Link href="/agent" className={styles.modeCta}>
            Open the arena →
          </Link>
        </article>
      </section>

      <section className={styles.fair}>
        <div className={`paper-card ${styles.fairStrip}`}>
          <div className={styles.fairHead}>
            <h3 className={styles.fairTitle}>Provably fair, annoyingly so.</h3>
            <p className={styles.fairSub}>The shuffle is committed before anyone sees a card.</p>
          </div>
          <div className={styles.fairSteps}>
            <div className={styles.fairStep}>
              <span className={styles.fairCode}>commit = sha256(deck ‖ seed)</span>
              <span className={styles.fairNote}>Published before the first card leaves the deck.</span>
            </div>
            <span className={styles.fairArrow}>→</span>
            <div className={styles.fairStep}>
              <span className={styles.fairCode}>reveal seed</span>
              <span className={styles.fairNote}>The server seed is disclosed once the hand ends.</span>
            </div>
            <span className={styles.fairArrow}>→</span>
            <div className={styles.fairStep}>
              <span className={styles.fairCode}>verify replay</span>
              <span className={styles.fairNote}>Re-derive the deck yourself. The math doesn&apos;t bluff.</span>
            </div>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <span>invite-only stakes</span>
        <span className={styles.footerSep}>·</span>
        <span>tokens, not dollars</span>
        <span className={styles.footerSep}>·</span>
        <a href="https://github.com/8Traffic-Vibes/table-stakes" target="_blank" rel="noreferrer">
          github
        </a>
      </footer>
    </main>
  );
}
