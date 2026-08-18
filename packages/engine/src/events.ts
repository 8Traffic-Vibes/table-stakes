import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DomainEvent, LegalAction, PlayerAction } from "@hivetech/poker-engine";

/** Cost/usage metadata for one LLM decision, straight from OpenRouter's usage accounting. */
export interface InferenceMeta {
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  /** What OpenRouter charged the account. On BYOK this is only the ~5% fee. */
  readonly costUsd: number;
  /** Upstream provider cost (the real bill on BYOK); informational elsewhere. */
  readonly upstreamCostUsd: number | null;
  readonly generationId: string | null;
  readonly finishReason: string | null;
  readonly latencyMs: number;
}

export type TableEvent =
  | {
      readonly type: "session_started";
      readonly table: string;
      readonly config: unknown;
      readonly peg: unknown;
      readonly keyLimitRemainingUsd: number | null;
      readonly players: ReadonlyArray<{ playerId: string; name: string; model?: string }>;
    }
  | { readonly type: "buy_in"; readonly playerId: string; readonly tokens: number }
  | {
      readonly type: "deck_committed";
      readonly handNo: number;
      readonly commit: string;
    }
  | {
      readonly type: "seeds_collected";
      readonly handNo: number;
      /** Ordered — the order is part of the deck derivation. */
      readonly seeds: ReadonlyArray<{ readonly playerId: string; readonly seed: string }>;
      /** M1 honesty: model seats don't choose seeds yet; the table draws them. */
      readonly drawnBy: "table" | "seats";
    }
  | { readonly type: "engine_event"; readonly handNo: number; readonly event: DomainEvent }
  | {
      readonly type: "action_requested";
      readonly handNo: number;
      readonly playerId: string;
      readonly legal: readonly LegalAction[];
      readonly deadlineMs: number;
    }
  | {
      readonly type: "action_decided";
      readonly handNo: number;
      readonly playerId: string;
      readonly action: PlayerAction;
      /** Set when the seat's requested amount was clamped into the legal range. */
      readonly adjusted?: string;
      /** Set when the seat failed (timeout, parse error, illegal action) and the table acted for it. */
      readonly fallback?: string;
      readonly inference?: InferenceMeta;
    }
  | {
      readonly type: "chat_said";
      readonly handNo: number | null;
      readonly playerId: string;
      readonly text: string;
    }
  | {
      readonly type: "reaction_added";
      readonly handNo: number | null;
      readonly playerId: string;
      readonly emoji: string;
      /** seq of the logged event this reaction is pinned to, if any. */
      readonly targetSeq?: number;
    }
  | {
      readonly type: "seed_revealed";
      readonly handNo: number;
      readonly serverSeed: string;
      readonly deckCodes: readonly string[];
    }
  | {
      readonly type: "hand_settled";
      readonly handNo: number;
      readonly deltasTokens: Readonly<Record<string, number>>;
      readonly inferenceUsd: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "session_ended";
      readonly finalStacks: Readonly<Record<string, number>>;
      readonly summary: string;
      /** Set when the session stopped early (e.g. OpenRouter unreachable). */
      readonly aborted?: string;
    };

export type LoggedEvent = TableEvent & { readonly seq: number; readonly ts: string };

/** Append-only JSONL event log: the single source of truth for replay, export, audit. */
export class EventLog {
  private seq = 0;
  private readonly all: LoggedEvent[] = [];

  constructor(
    private readonly filePath: string,
    private readonly onEvent?: (event: LoggedEvent) => void,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  append(event: TableEvent): LoggedEvent {
    this.seq += 1;
    const logged: LoggedEvent = { ...event, seq: this.seq, ts: new Date().toISOString() };
    appendFileSync(this.filePath, `${JSON.stringify(logged)}\n`, "utf8");
    this.all.push(logged);
    this.onEvent?.(logged);
    return logged;
  }

  events(): readonly LoggedEvent[] {
    return this.all;
  }

  handEvents(handNo: number): readonly LoggedEvent[] {
    return this.all.filter((e) => "handNo" in e && e.handNo === handNo);
  }
}
