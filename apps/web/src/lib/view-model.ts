/**
 * The one table shape every surface consumes — the three.js scene, the DOM
 * overlays, mobile and desktop, human rooms (SSE snapshots) and the local
 * agent server (WS events reduced client-side).
 */

export interface SeatVM {
  readonly playerId: string;
  readonly name: string;
  readonly seatType: "human" | "model" | "acp" | "mcp";
  readonly stack: number;
  readonly folded: boolean;
  readonly sittingOut: boolean;
  /** Card codes like "As","Td" when known to this viewer; null = face-down backs; empty = no cards. */
  readonly holeCards: readonly string[] | null;
  readonly lastAction: string | null;
  readonly committedStreet: number;
  readonly isDealer: boolean;
  readonly isActor: boolean;
}

export interface ChatLineVM {
  readonly seq: number;
  readonly from: string;
  readonly text: string;
  readonly system?: boolean;
}

export interface ReactionVM {
  readonly seq: number;
  readonly from: string;
  readonly emoji: string;
}

export interface LegalVM {
  readonly kind: "fold" | "check" | "call" | "bet-to" | "raise-to";
  readonly amount?: number;
  readonly min?: number;
  readonly max?: number;
}

export interface YouVM {
  readonly playerId: string;
  readonly holeCards: readonly string[];
  /** Non-null exactly when it is your turn. */
  readonly legal: readonly LegalVM[] | null;
  readonly deadlineAt: number | null;
}

export interface SettlementVM {
  readonly finalStacks: ReadonlyArray<{ name: string; stack: number; net: number }>;
  readonly pairs: ReadonlyArray<{ from: string; to: string; tokens: number }>;
}

export interface TableVM {
  readonly table: string;
  readonly phase: "waiting" | "playing" | "ended";
  readonly handNo: number;
  readonly street: string;
  readonly board: readonly string[];
  readonly pot: number;
  readonly blinds: { readonly small: number; readonly big: number };
  readonly chipsPerToken: { readonly tokensPerChip: number; readonly referenceModel: string };
  readonly seats: readonly SeatVM[];
  readonly chat: readonly ChatLineVM[];
  readonly reactions: readonly ReactionVM[];
  readonly you: YouVM | null;
  /** Current hand's deck commitment (truncated ok for display). */
  readonly commit: string | null;
  readonly settlement: SettlementVM | null;
}

export const EMOJI_PALETTE = ["🤡", "😂", "🔥", "💀", "🫡", "😱", "🧂", "🤖"] as const;

export function formatTokens(tokens: number): string {
  const sign = tokens < 0 ? "-" : "";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString("en-US")}`;
}
