"use client";

import { useEffect, useRef, useState } from "react";
import { formatTokens, type LegalVM } from "@/lib/view-model";
import styles from "./ActionBar.module.css";

interface ActionBarProps {
  readonly legal: readonly LegalVM[];
  readonly pot: number;
  readonly deadlineAt: number | null;
  readonly onAct: (
    action: { kind: string; amount?: number },
    say?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  readonly notify: (message: string) => void;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

function Countdown({ deadlineAt }: { deadlineAt: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, deadlineAt - Date.now()));
  const totalRef = useRef<number>(Math.max(1_000, deadlineAt - Date.now()));

  useEffect(() => {
    totalRef.current = Math.max(1_000, deadlineAt - Date.now());
    const tick = (): void => setRemaining(Math.max(0, deadlineAt - Date.now()));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [deadlineAt]);

  const pct = Math.min(100, (remaining / totalRef.current) * 100);
  const urgent = remaining < 8_000;
  return (
    <div className={styles.clockTrack} role="timer" aria-label="Time to act">
      <div
        className={`${styles.clockFill} ${urgent ? styles.clockUrgent : ""}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function ActionBar({ legal, pot, deadlineAt, onAct, notify }: ActionBarProps) {
  const [say, setSay] = useState("");
  const [pending, setPending] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const fold = legal.find((a) => a.kind === "fold");
  const check = legal.find((a) => a.kind === "check");
  const call = legal.find((a) => a.kind === "call");
  const range = legal.find((a) => a.kind === "bet-to" || a.kind === "raise-to");
  const min = range?.min ?? 0;
  const max = range?.max ?? 0;
  const rangeVerb = range?.kind === "bet-to" ? "Bet" : "Raise";

  const [target, setTarget] = useState(min);

  const act = async (action: { kind: string; amount?: number }): Promise<void> => {
    if (pending) return;
    setPending(true);
    const trimmed = say.trim();
    const result = await onAct(action, trimmed ? trimmed : undefined);
    if (!result.ok) {
      notify(result.error ?? "that didn't go through");
      setPending(false);
    }
    // On success the next snapshot removes our `legal` and this bar unmounts.
  };

  return (
    <div className={styles.wrap}>
      {deadlineAt !== null && <Countdown deadlineAt={deadlineAt} />}

      <input
        className={styles.say}
        value={say}
        onChange={(event) => setSay(event.target.value)}
        maxLength={200}
        placeholder="talk your talk…"
        aria-label="Table talk to send with your action"
        enterKeyHint="done"
      />

      {!sheetOpen && (
        <div className={styles.row}>
          {fold && (
            <button
              type="button"
              className={`${styles.btn} ${styles.foldBtn}`}
              disabled={pending}
              onClick={() => void act({ kind: "fold" })}
            >
              Fold
            </button>
          )}
          {check && (
            <button
              type="button"
              className={styles.btn}
              disabled={pending}
              onClick={() => void act({ kind: "check" })}
            >
              Check
            </button>
          )}
          {call && (
            <button
              type="button"
              className={styles.btn}
              disabled={pending}
              onClick={() => void act({ kind: "call" })}
            >
              Call <span className="num">{formatTokens(call.amount ?? 0)}</span>
            </button>
          )}
          {range && (
            <button
              type="button"
              className={`${styles.btn} ${styles.raiseBtn}`}
              disabled={pending}
              onClick={() => {
                setTarget(min);
                setSheetOpen(true);
              }}
            >
              {rangeVerb}
            </button>
          )}
        </div>
      )}

      {sheetOpen && range && (
        <div className={styles.sheet}>
          <div className={styles.sheetHead}>
            <span className={styles.sheetLabel}>
              {range.kind === "bet-to" ? "Bet" : "Raise to"}
            </span>
            <span className={`${styles.sheetAmount} num`}>{formatTokens(target)}</span>
          </div>
          <input
            type="range"
            className={styles.slider}
            min={min}
            max={max}
            step={1}
            value={target}
            onChange={(event) => setTarget(Number(event.target.value))}
            aria-label={`${rangeVerb} amount`}
          />
          <div className={styles.quickRow}>
            <button type="button" className={styles.quick} onClick={() => setTarget(min)}>
              Min
            </button>
            <button
              type="button"
              className={styles.quick}
              onClick={() => setTarget(clamp(pot / 2, min, max))}
            >
              ½ pot
            </button>
            <button
              type="button"
              className={styles.quick}
              onClick={() => setTarget(clamp(pot, min, max))}
            >
              Pot
            </button>
            <button type="button" className={styles.quick} onClick={() => setTarget(max)}>
              All-in
            </button>
          </div>
          <div className={styles.sheetActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.backBtn}`}
              disabled={pending}
              onClick={() => setSheetOpen(false)}
            >
              Back
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.confirmBtn}`}
              disabled={pending}
              onClick={() => void act({ kind: range.kind, amount: target })}
            >
              {target >= max ? "All-in" : rangeVerb}{" "}
              <span className="num">{formatTokens(target)}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
