import type { LegalAction } from "@table-stakes/engine";
import {
  fallbackAction,
  sanitizeEmoji,
  sanitizeSay,
  type ActionEnvelope,
  type Reaction,
  type SeatView,
} from "./driver.ts";
import { resolveAction } from "./parse.ts";

export interface PendingTurn {
  readonly playerId: string;
  readonly view: SeatView;
  readonly legal: readonly LegalAction[];
  readonly deadlineAt: number;
}

export interface RawSubmission {
  readonly kind: string;
  readonly amount?: number;
  readonly say?: string;
  readonly react?: { readonly emoji: string; readonly targetSeq?: number };
}

interface PendingEntry extends PendingTurn {
  resolve(envelope: ActionEnvelope): void;
  timer: NodeJS.Timeout;
}

/**
 * Bridges push-driven seats (the session asks for an action) to pull-driven
 * surfaces (a browser or an MCP client submits one). One pending turn per
 * player; submissions validate through the same resolveAction path as models.
 */
export class ActionBus {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly turnWaiters = new Map<string, Array<(turn: PendingTurn | null) => void>>();
  private readonly notify = new Set<(turn: PendingTurn) => void>();

  constructor(private readonly chatCfg: { readonly maxChars: number }) {}

  /** Session side: ask for an action; self-folds shortly after the deadline. */
  request(
    playerId: string,
    view: SeatView,
    legal: readonly LegalAction[],
    deadlineMs: number,
  ): Promise<ActionEnvelope> {
    return new Promise<ActionEnvelope>((resolve) => {
      const deadlineAt = Date.now() + deadlineMs;
      const timer = setTimeout(() => {
        this.pending.delete(playerId);
        resolve({ action: fallbackAction(legal), fallback: "clock expired" });
      }, deadlineMs);
      timer.unref?.();
      const entry: PendingEntry = { playerId, view, legal, deadlineAt, resolve, timer };
      this.pending.set(playerId, entry);
      const turn: PendingTurn = { playerId, view, legal, deadlineAt };
      for (const waiter of this.turnWaiters.get(playerId) ?? []) waiter(turn);
      this.turnWaiters.delete(playerId);
      for (const listener of this.notify) listener(turn);
    });
  }

  peek(playerId: string): PendingTurn | null {
    const entry = this.pending.get(playerId);
    return entry ? { playerId, view: entry.view, legal: entry.legal, deadlineAt: entry.deadlineAt } : null;
  }

  /** Long-poll (MCP): resolves with the turn when it arrives, or null on timeout. */
  waitForTurn(playerId: string, timeoutMs: number): Promise<PendingTurn | null> {
    const current = this.peek(playerId);
    if (current) return Promise.resolve(current);
    return new Promise((resolve) => {
      const waiters = this.turnWaiters.get(playerId) ?? [];
      const timer = setTimeout(() => {
        const list = this.turnWaiters.get(playerId) ?? [];
        this.turnWaiters.set(list.length ? playerId : playerId, list.filter((w) => w !== entry));
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      const entry = (turn: PendingTurn | null): void => {
        clearTimeout(timer);
        resolve(turn);
      };
      waiters.push(entry);
      this.turnWaiters.set(playerId, waiters);
    });
  }

  /** Surface side: submit a decision for the pending turn. */
  submit(playerId: string, raw: RawSubmission): { ok: true } | { ok: false; error: string } {
    const entry = this.pending.get(playerId);
    if (!entry) return { ok: false, error: "it is not your turn" };
    const resolved = resolveAction(
      {
        kind: raw.kind.toLowerCase().trim(),
        ...(raw.amount !== undefined && Number.isFinite(raw.amount)
          ? { amount: Math.round(raw.amount) }
          : {}),
      },
      entry.legal,
    );
    const say = raw.say ? sanitizeSay(raw.say, this.chatCfg.maxChars) : undefined;
    const emoji = raw.react ? sanitizeEmoji(raw.react.emoji) : null;
    const react: Reaction | undefined = emoji
      ? { emoji, ...(raw.react?.targetSeq !== undefined ? { targetSeq: raw.react.targetSeq } : {}) }
      : undefined;
    clearTimeout(entry.timer);
    this.pending.delete(playerId);
    entry.resolve({
      ...resolved,
      ...(say ? { say } : {}),
      ...(react ? { react } : {}),
    });
    return { ok: true };
  }

  /** Subscribe to every new turn (web server pushes act_request frames). */
  onTurn(listener: (turn: PendingTurn) => void): () => void {
    this.notify.add(listener);
    return () => this.notify.delete(listener);
  }
}
