"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import ActionBar from "@/components/play/ActionBar";
import ChatPanel from "@/components/play/ChatPanel";
import JoinSheet from "@/components/play/JoinSheet";
import SettlementCard from "@/components/play/SettlementCard";
import TopBar from "@/components/play/TopBar";
import WaitingPanel from "@/components/play/WaitingPanel";
import { joinRoom, loadSeat, useRoom, type SeatSession } from "@/lib/human-client";
import styles from "./page.module.css";

const TableScene = dynamic(() => import("@/components/TableScene"), {
  ssr: false,
  loading: () => <div className={styles.shimmer} aria-hidden />,
});

const MAX_SEATS = 6;

export default function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId: rawRoomId } = use(params);
  const roomId = decodeURIComponent(rawRoomId).toUpperCase();

  const [seat, setSeat] = useState<SeatSession | null>(null);
  const [seatChecked, setSeatChecked] = useState(false);
  const [spectating, setSpectating] = useState(false);
  const [isMobile, setIsMobile] = useState(true);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reactionBase = useRef<number | null>(null);

  const { vm, error, connected, send } = useRoom(roomId, seat?.token ?? null);

  useEffect(() => {
    setSeat(loadSeat(roomId));
    setSeatChecked(true);
  }, [roomId]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = (): void => setIsMobile(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (vm && reactionBase.current === null) {
      reactionBase.current = vm.reactions.reduce((max, r) => Math.max(max, r.seq), 0);
    }
  }, [vm]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const notify = useCallback((text: string): void => {
    setToast({ text, key: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const copyLink = useCallback((): void => {
    const url = `${window.location.origin}/play/${roomId}`;
    void navigator.clipboard
      .writeText(url)
      .then(() => notify("link copied"))
      .catch(() => notify(`couldn't copy — code is ${roomId}`));
  }, [roomId, notify]);

  const handleJoin = useCallback(
    async (name: string): Promise<{ ok: boolean; error?: string }> => {
      const result = await joinRoom(roomId, name);
      if (result.ok) {
        setSeat({ token: result.token, playerId: result.playerId, name: name.trim() });
        setSpectating(false);
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },
    [roomId],
  );

  const handleStart = useCallback(async (): Promise<void> => {
    const result = await send("start");
    if (!result.ok) {
      notify(
        result.error === "only the host starts the game"
          ? "host only — ask whoever opened the table"
          : (result.error ?? "couldn't start"),
      );
    }
  }, [send, notify]);

  const handleEnd = useCallback((): void => {
    const sure = window.confirm(
      "End the session for everyone? Stacks settle as they stand.",
    );
    if (!sure) return;
    void send("end").then((result) => {
      if (!result.ok) {
        notify(
          result.error === "only the host ends the session"
            ? "host only — ask whoever opened the table"
            : (result.error ?? "couldn't end the session"),
        );
      }
    });
  }, [send, notify]);

  const handleAct = useCallback(
    (action: { kind: string; amount?: number }, say?: string) =>
      send("act", { action, ...(say ? { say } : {}) }),
    [send],
  );

  const handleChat = useCallback((text: string) => send("chat", { text }), [send]);
  const handleReact = useCallback((emoji: string) => send("react", { emoji }), [send]);

  const handleRebuy = useCallback((): void => {
    void send("rebuy").then((result) => {
      if (!result.ok) notify(result.error ?? "rebuy failed");
    });
  }, [send, notify]);

  const seated = seat !== null;
  const youSeat = vm && vm.you ? vm.seats.find((s) => s.playerId === vm.you?.playerId) : undefined;
  const busted = vm?.phase === "playing" && youSeat !== undefined && youSeat.stack === 0;
  const actionBarVisible = Boolean(vm?.you?.legal && vm.you.legal.length > 0);
  const liveReactions =
    vm && reactionBase.current !== null
      ? vm.reactions.filter((r) => r.seq > (reactionBase.current ?? 0)).slice(-5)
      : [];

  return (
    <div className={styles.screen}>
      <div className={styles.stage}>
        {vm ? (
          <TableScene vm={vm} quality={isMobile ? "mobile" : "desktop"} />
        ) : (
          <div className={styles.shimmer} aria-hidden />
        )}
      </div>

      <TopBar
        code={roomId}
        handNo={vm?.handNo ?? 0}
        blinds={vm?.blinds ?? null}
        connected={connected}
        seated={seated}
        spectating={!seated && spectating}
        onCopyLink={copyLink}
        onEndSession={handleEnd}
      />

      {error && (
        <div className={styles.centerWrap}>
          <section className={`${styles.errorCard} paper-card`}>
            <h2 className={styles.errorTitle}>This table folded</h2>
            <p className={styles.errorBody}>{error}</p>
            <Link href="/play" className="pill">
              Back to lobby
            </Link>
          </section>
        </div>
      )}

      {!error && vm?.phase === "waiting" && (
        <div className={styles.centerWrap}>
          <WaitingPanel
            code={roomId}
            seats={vm.seats}
            maxSeats={MAX_SEATS}
            seated={seated}
            onStart={handleStart}
            onCopyLink={copyLink}
          />
        </div>
      )}

      {!error && vm?.phase === "ended" && vm.settlement && (
        <div className={styles.centerWrap}>
          <SettlementCard code={roomId} settlement={vm.settlement} />
        </div>
      )}

      {!error && seatChecked && !seated && !spectating && vm?.phase !== "ended" && (
        <JoinSheet
          code={roomId}
          phase={vm?.phase ?? null}
          onJoin={handleJoin}
          onSpectate={() => setSpectating(true)}
        />
      )}

      {!error && actionBarVisible && vm?.you?.legal && (
        <ActionBar
          key={vm.you.deadlineAt ?? vm.handNo}
          legal={vm.you.legal}
          pot={vm.pot}
          deadlineAt={vm.you.deadlineAt}
          onAct={handleAct}
          notify={notify}
        />
      )}

      {!error && busted && !actionBarVisible && (
        <button type="button" className={`pill ${styles.rebuy}`} onClick={handleRebuy}>
          Busted — rebuy your stack
        </button>
      )}

      {!error && vm && (
        <ChatPanel
          chat={vm.chat}
          canTalk={seated}
          isMobile={isMobile}
          actionBarVisible={actionBarVisible}
          onChat={handleChat}
          onReact={handleReact}
          notify={notify}
        />
      )}

      {liveReactions.length > 0 && (
        <div className={styles.reactions} aria-hidden>
          {liveReactions.map((reaction) => (
            <span key={reaction.seq} className={styles.reaction}>
              <span className={styles.reactionEmoji}>{reaction.emoji}</span>
              <span className={styles.reactionFrom}>{reaction.from}</span>
            </span>
          ))}
        </div>
      )}

      {toast && (
        <div key={toast.key} className={styles.toast} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
