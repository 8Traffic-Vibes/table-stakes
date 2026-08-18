"use client";

import { useEffect, useRef, useState } from "react";
import { EMOJI_PALETTE, type ChatLineVM } from "@/lib/view-model";
import styles from "./ChatPanel.module.css";

interface ChatPanelProps {
  readonly chat: readonly ChatLineVM[];
  readonly canTalk: boolean;
  readonly isMobile: boolean;
  readonly actionBarVisible: boolean;
  readonly onChat: (text: string) => Promise<{ ok: boolean; error?: string }>;
  readonly onReact: (emoji: string) => Promise<{ ok: boolean; error?: string }>;
  readonly notify: (message: string) => void;
}

export default function ChatPanel({
  chat,
  canTalk,
  isMobile,
  actionBarVisible,
  onChat,
  onReact,
  notify,
}: ChatPanelProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [lastSeen, setLastSeen] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openedForDesktop = useRef(false);

  const maxSeq = chat.length > 0 ? chat[chat.length - 1]!.seq : 0;

  useEffect(() => {
    if (!isMobile && !openedForDesktop.current) {
      openedForDesktop.current = true;
      setOpen(true);
    }
  }, [isMobile]);

  useEffect(() => {
    if (open) setLastSeen(maxSeq);
  }, [open, maxSeq]);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [open, chat.length, maxSeq]);

  const unread = chat.filter((line) => line.seq > lastSeen && !line.system).length;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const result = await onChat(text);
    if (result.ok) setDraft("");
    else notify(result.error ?? "message didn't land");
    setSending(false);
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          className={`${styles.toggle} ${actionBarVisible ? styles.toggleRaised : ""}`}
          onClick={() => setOpen(true)}
          aria-label={`Open table talk${unread > 0 ? ` — ${unread} new` : ""}`}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
          {unread > 0 && <span className={styles.badge}>{unread > 9 ? "9+" : unread}</span>}
        </button>
      )}

      {open && (
        <section className={styles.panel} aria-label="Table talk">
          <header className={styles.head}>
            <span className={styles.headTitle}>Table talk</span>
            <button
              type="button"
              className={styles.close}
              onClick={() => setOpen(false)}
              aria-label="Collapse chat"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </header>

          <div className={styles.lines} ref={listRef}>
            {chat.length === 0 && (
              <p className={styles.empty}>Quiet table. Someone say something rash.</p>
            )}
            {chat.map((line) => (
              <p
                key={line.seq}
                className={`${styles.line} ${line.system ? styles.lineSystem : ""}`}
              >
                {!line.system && <span className={styles.from}>{line.from}</span>}
                <span className={styles.text}>{line.text}</span>
              </p>
            ))}
          </div>

          {canTalk && (
            <div className={styles.composer}>
              <div className={styles.emojiRow} role="group" aria-label="Reactions">
                {EMOJI_PALETTE.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={styles.emoji}
                    onClick={() => {
                      void onReact(emoji).then((result) => {
                        if (!result.ok) notify(result.error ?? "reaction bounced");
                      });
                    }}
                    aria-label={`React ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <form className={styles.inputRow} onSubmit={submit}>
                <input
                  className={styles.input}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={200}
                  placeholder="talk your talk…"
                  aria-label="Chat message"
                  enterKeyHint="send"
                />
                <button
                  type="submit"
                  className={styles.send}
                  disabled={sending || !draft.trim()}
                  aria-label="Send"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </form>
            </div>
          )}
          {!canTalk && <p className={styles.spectatorNote}>take a seat to talk</p>}
        </section>
      )}
    </>
  );
}
