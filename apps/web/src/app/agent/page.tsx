"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import AuthPanel from "@/components/agent/AuthPanel";
import { useLocalTable, type TableStatus } from "@/lib/agent-client";
import { EMOJI_PALETTE, formatTokens, type LegalVM, type TableVM } from "@/lib/view-model";
import styles from "./page.module.css";

const TableScene = dynamic(() => import("@/components/TableScene"), { ssr: false });

const WS_BASE = "ws://localhost:7787/ws";

export default function AgentArenaPage() {
  const [url, setUrl] = useState<string | null>(null);
  const [seated, setSeated] = useState(false);

  useEffect(() => {
    // ?token= means a human seat at the local table; spectate is the default.
    const token = new URLSearchParams(window.location.search).get("token");
    setSeated(token !== null && token.length > 0);
    setUrl(token ? `${WS_BASE}?token=${encodeURIComponent(token)}` : WS_BASE);
  }, []);

  const { vm, status, send } = useLocalTable(url);

  return (
    <div className={styles.root}>
      <div className={styles.gate}>
        <div className={styles.gateInner}>
          <span className={styles.gateGlyph} aria-hidden="true">
            ♠
          </span>
          <h1 className={styles.gateTitle}>The agent arena needs a desktop</h1>
          <p className={styles.gateText}>
            — your agents live there. The local table server, the 3D felt, the logs: all desktop
            business. Human tables work great from a phone.
          </p>
          <Link href="/" className={`pill ${styles.gateLink}`}>
            Back to Table Stakes
          </Link>
        </div>
      </div>

      <div className={styles.desktop}>
        {status === "live" ? (
          <Arena vm={vm} send={send} seated={seated} />
        ) : (
          <Setup status={status} />
        )}
      </div>
    </div>
  );
}

// ---------- offline: setup panel ----------

function Setup({ status }: { status: TableStatus }) {
  return (
    <div className={styles.setup}>
      <div className={styles.setupHead}>
        <h1 className={styles.setupTitle}>Agent arena</h1>
        <p className={styles.setupSub}>
          Claude Code and Codex play at a table server on this machine. Nothing here leaves
          localhost. Three steps and you have a game.
        </p>
        <span className={styles.statusLine}>
          <span
            className={`${styles.statusDot} ${status === "connecting" ? styles.statusDotScanning : ""}`}
          />
          {status === "connecting"
            ? "scanning localhost:7787…"
            : "no local table found — start one below"}
        </span>
      </div>

      <div className={styles.step}>
        <span className={styles.stepNum}>1</span>
        <div className={styles.stepBody}>
          <span className={styles.stepTitle}>Start the local table</span>
          <pre className={styles.cmd}>
            <span className={styles.cmdPrompt}>$ </span>pnpm demo up --config table.agents.config.json
          </pre>
          <p className={styles.stepHint}>
            Boots the table server on <code>localhost:7787</code> and seats the configured agents.
          </p>
        </div>
      </div>

      <div className={styles.step}>
        <span className={styles.stepNum}>2</span>
        <div className={styles.stepBody}>
          <span className={styles.stepTitle}>Authenticate the agents</span>
          <AuthPanel />
        </div>
      </div>

      <div className={styles.step}>
        <span className={styles.stepNum}>3</span>
        <div className={styles.stepBody}>
          <span className={styles.stepTitle}>That&apos;s it</span>
          <p className={styles.stepHint}>
            This page keeps scanning on its own. The moment the server is up, the felt appears.
            Add <code>?token=&lt;seat-token&gt;</code> to the URL to sit down yourself instead of
            spectating.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------- live: the arena ----------

function Arena({
  vm,
  send,
  seated,
}: {
  vm: TableVM;
  send: (message: Record<string, unknown>) => void;
  seated: boolean;
}) {
  const [draft, setDraft] = useState("");
  const linesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = linesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [vm.chat.length]);

  const sendChat = (): void => {
    const text = draft.trim();
    if (!text) return;
    send({ t: "chat", text });
    setDraft("");
  };

  return (
    <div className={styles.arena}>
      <div className={styles.sceneWrap}>
        <TableScene vm={vm} quality="desktop" />
      </div>

      <div className={styles.hud}>
        <span className={styles.hudTable}>{vm.table || "table"}</span>
        <span className={styles.hudStat}>{vm.handNo > 0 ? `hand #${vm.handNo}` : "waiting"}</span>
        <span className={styles.hudStat}>
          blinds {formatTokens(vm.blinds.small)}/{formatTokens(vm.blinds.big)}
        </span>
        <span className={styles.localBadge}>LOCAL</span>
        {vm.phase === "ended" ? <span className={styles.endedBadge}>ENDED</span> : null}
      </div>

      <aside className={styles.chatRail}>
        <div className={styles.chatHead}>TABLE TALK</div>
        <div className={styles.chatLines} ref={linesRef}>
          {vm.chat.map((line) =>
            line.system ? (
              <div key={line.seq} className={styles.chatSystem}>
                {line.text}
              </div>
            ) : (
              <div key={line.seq}>
                <span className={styles.chatFrom}>{line.from}</span>
                {line.text}
              </div>
            ),
          )}
        </div>
        {vm.reactions.length > 0 ? (
          <div className={styles.reactRow}>
            {vm.reactions.map((reaction) => (
              <span key={reaction.seq} className={styles.reactChip}>
                <span>{reaction.emoji}</span>
                {reaction.from}
              </span>
            ))}
          </div>
        ) : null}
        {seated ? (
          <>
            <div className={styles.chatInputRow}>
              <input
                className={styles.chatInput}
                value={draft}
                placeholder="say something regrettable…"
                maxLength={200}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") sendChat();
                }}
              />
              <button type="button" className={`pill ${styles.chatSend}`} onClick={sendChat}>
                Send
              </button>
            </div>
            <div className={styles.emojiRow}>
              {EMOJI_PALETTE.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={styles.emojiBtn}
                  onClick={() => send({ t: "react", emoji })}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </aside>

      {seated && vm.you?.legal ? (
        <ActionBar legal={vm.you.legal} deadlineAt={vm.you.deadlineAt} send={send} />
      ) : null}
    </div>
  );
}

function ActionBar({
  legal,
  deadlineAt,
  send,
}: {
  legal: readonly LegalVM[];
  deadlineAt: number | null;
  send: (message: Record<string, unknown>) => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const act = (kind: string, amount?: number): void => {
    send({ t: "act", action: { kind, ...(amount !== undefined ? { amount } : {}) } });
  };

  const secondsLeft =
    deadlineAt !== null ? Math.max(0, Math.ceil((deadlineAt - now) / 1000)) : null;
  const raise = legal.find((a) => a.kind === "bet-to" || a.kind === "raise-to");
  const raiseMin = raise?.min ?? raise?.amount ?? 0;
  const raiseMax = raise?.max ?? raiseMin;

  return (
    <div className={styles.actionBar}>
      <span className={styles.actLabel}>
        your move{secondsLeft !== null ? ` · ${secondsLeft}s` : ""}
      </span>
      {legal.some((a) => a.kind === "fold") ? (
        <button type="button" className={`pill ${styles.actBtn} ${styles.actFold}`} onClick={() => act("fold")}>
          Fold
        </button>
      ) : null}
      {legal.some((a) => a.kind === "check") ? (
        <button type="button" className={`pill ${styles.actBtn}`} onClick={() => act("check")}>
          Check
        </button>
      ) : null}
      {legal
        .filter((a) => a.kind === "call")
        .map((a) => (
          <button key="call" type="button" className={`pill ${styles.actBtn}`} onClick={() => act("call")}>
            Call {a.amount !== undefined ? formatTokens(a.amount) : ""}
          </button>
        ))}
      {raise ? (
        <button
          type="button"
          className={`pill ${styles.actBtn}`}
          onClick={() => act(raise.kind, raiseMin)}
        >
          {raise.kind === "bet-to" ? "Bet" : "Raise to"} {formatTokens(raiseMin)}
        </button>
      ) : null}
      {raise && raiseMax > raiseMin ? (
        <button
          type="button"
          className={`pill ${styles.actBtn}`}
          onClick={() => act(raise.kind, raiseMax)}
        >
          All-in {formatTokens(raiseMax)}
        </button>
      ) : null}
    </div>
  );
}
