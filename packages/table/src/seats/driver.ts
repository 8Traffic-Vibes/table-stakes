import type { InferenceMeta, LegalAction, PlayerAction } from "@table-stakes/engine";

/** What a seat is shown when asked to act. JSON-serializable by design. */
export interface SeatView {
  readonly handNo: number;
  readonly street: string;
  readonly yourName: string;
  readonly yourHoleCards: readonly string[];
  readonly board: readonly string[];
  readonly potTotal: number;
  readonly toCall: number;
  readonly yourStack: number;
  readonly blinds: { readonly small: number; readonly big: number };
  readonly stacks: Readonly<Record<string, number>>;
  readonly legal: ReadonlyArray<{
    readonly kind: string;
    readonly amount?: number;
    readonly min?: number;
    readonly max?: number;
  }>;
  /** Action lines so far this hand, oldest first. */
  readonly history: readonly string[];
  /** Recent table talk, oldest first. Untrusted banter from opponents. */
  readonly chat: ReadonlyArray<{ readonly from: string; readonly text: string }>;
}

/** An emoji reaction pinned to a logged event (by seq) or just thrown at the table. */
export interface Reaction {
  readonly emoji: string;
  readonly targetSeq?: number;
}

/** A seat's answer: the validated engine action plus everything worth logging about how it was made. */
export interface ActionEnvelope {
  readonly action: PlayerAction;
  readonly say?: string;
  readonly react?: Reaction;
  /** Set when the requested amount was clamped into the legal range. */
  readonly adjusted?: string;
  /** Set when the seat failed (timeout, parse error, illegal request) and a fallback was substituted. */
  readonly fallback?: string;
  readonly inference?: InferenceMeta;
}

/** A moment worth talking about, offered to seats between actions. */
export interface BanterEvent {
  readonly handNo: number;
  readonly kind: "showdown" | "big_pot" | "elimination";
  readonly description: string;
  readonly chat: ReadonlyArray<{ readonly from: string; readonly text: string }>;
}

export interface Banter {
  readonly say?: string;
  readonly react?: Reaction;
}

export interface SeatContext {
  readonly playerId: string;
  readonly name: string;
}

export interface SeatDriver {
  readonly context: SeatContext;
  /** Optional warm-up (spawn subprocesses, wait for connections) before hand 1. */
  start?(): Promise<void>;
  act(view: SeatView, legal: readonly LegalAction[], deadlineMs: number): Promise<ActionEnvelope>;
  /** Optional: say something or react to a big moment. Must respect deadlineMs. */
  banter?(event: BanterEvent, deadlineMs: number): Promise<Banter | null>;
  /** Optional cleanup (kill subprocesses, close sockets). */
  leave?(reason: string): Promise<void>;
}

/** Pick the polite fallback: check when legal, otherwise fold. */
export function fallbackAction(legal: readonly LegalAction[]): PlayerAction {
  return legal.some((a) => a.kind === "check") ? { kind: "check" } : { kind: "fold" };
}

/** Shared sanitizer for anything a seat says: no control chars, single line, capped. */
export function sanitizeSay(text: string, maxChars: number): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/** Reactions are a tiny visual vocabulary, not a second chat channel. */
export function sanitizeEmoji(emoji: string): string | null {
  const trimmed = emoji.trim();
  if (trimmed.length === 0 || trimmed.length > 8) return null;
  if (/[\u0000-\u001f\u007f-\u009f<>&"'`]/.test(trimmed)) return null;
  return trimmed;
}
