"use client";

/**
 * Agent auth status cards for the local table server. Polls
 * http://localhost:7787/auth/status every 5s (CORS is enabled server-side)
 * and offers the Codex ChatGPT-OAuth login kick-off.
 */

import { useCallback, useEffect, useState } from "react";
import styles from "./AuthPanel.module.css";

const AUTH_BASE = "http://localhost:7787";

interface AuthStatus {
  readonly claude: boolean;
  readonly codex: boolean;
}

type CodexLogin = "idle" | "launching" | "launched" | "failed";

export default function AuthPanel() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [login, setLogin] = useState<CodexLogin>("idle");

  useEffect(() => {
    let disposed = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${AUTH_BASE}/auth/status`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Partial<AuthStatus>;
        if (!disposed) setAuth({ claude: body.claude === true, codex: body.codex === true });
      } catch {
        if (!disposed) setAuth(null);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const startCodexLogin = useCallback(async () => {
    setLogin("launching");
    try {
      const res = await fetch(`${AUTH_BASE}/auth/codex-login`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean };
      setLogin(res.ok && body.ok ? "launched" : "failed");
    } catch {
      setLogin("failed");
    }
  }, []);

  return (
    <div>
      {auth === null ? (
        <p className={styles.unreachable}>auth status: waiting for the table server on localhost:7787…</p>
      ) : null}
      <div className={styles.grid}>
        <div className={`paper-card ${styles.card}`}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>Claude Code</span>
            <span className={`${styles.badge} ${auth?.claude ? styles.badgeOk : styles.badgeWait}`}>
              {auth?.claude ? "READY" : "NOT AUTHED"}
            </span>
          </div>
          {auth?.claude ? (
            <p className={styles.hint}>Token found. Claude Code can take its seat.</p>
          ) : (
            <>
              <p className={styles.hint}>Mint a long-lived token, export it, then restart the table server:</p>
              <pre className={styles.code}>{`claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=<paste>`}</pre>
              <p className={styles.note}>ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN also count.</p>
            </>
          )}
        </div>

        <div className={`paper-card ${styles.card}`}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>Codex — ChatGPT OAuth</span>
            <span className={`${styles.badge} ${auth?.codex ? styles.badgeOk : styles.badgeWait}`}>
              {auth?.codex ? "READY" : "NOT AUTHED"}
            </span>
          </div>
          {auth?.codex ? (
            <p className={styles.hint}>~/.codex/auth.json found. Codex can take its seat.</p>
          ) : (
            <>
              <p className={styles.hint}>
                Sign in with your ChatGPT account. A browser window opens on this machine — not here.
              </p>
              <button
                type="button"
                className={`pill ${styles.loginBtn}`}
                disabled={login === "launching" || auth === null}
                onClick={() => void startCodexLogin()}
              >
                {login === "launching" ? "Launching…" : "Sign in with ChatGPT"}
              </button>
              {login === "launched" ? (
                <p className={styles.note}>`codex login` launched — finish in the browser window that just opened.</p>
              ) : null}
              {login === "failed" ? (
                <p className={`${styles.note} ${styles.noteError}`}>
                  Couldn&apos;t launch `codex login`. Is the Codex CLI installed on the machine running the server?
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
