import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tier-0 ledger: an append-only JSONL record of stakes and settlements.
 * Token amounts are integers (reference-model tokens); inference spend is USD.
 */
export type LedgerEntry =
  | { readonly kind: "buy_in"; readonly playerId: string; readonly tokens: number }
  | {
      readonly kind: "hand_delta";
      readonly handNo: number;
      readonly playerId: string;
      readonly tokens: number;
    }
  | {
      readonly kind: "inference_spend";
      readonly handNo: number;
      readonly playerId: string;
      readonly usd: number;
      readonly generationId?: string;
      /** e.g. "late" when the result arrived after the table clock already folded the seat. */
      readonly note?: string;
    }
  | {
      /**
       * A request failed or timed out client-side: OpenRouter may still have
       * billed the generation, but its cost and id never reached us. The USD
       * totals under-report by these entries.
       */
      readonly kind: "inference_lost";
      readonly handNo: number;
      readonly playerId: string;
      readonly reason: string;
    }
  | {
      /**
       * thinkingBurnsStack: the player's own inference cost, converted to
       * tokens and burned off their result. Burns leave the table economy —
       * they are not won by anyone.
       */
      readonly kind: "burn";
      readonly handNo: number;
      readonly playerId: string;
      readonly tokens: number;
    }
  | { readonly kind: "session_close" };

export type LoggedLedgerEntry = LedgerEntry & { readonly seq: number; readonly ts: string };

export class Ledger {
  private seq = 0;
  private readonly entries: LoggedLedgerEntry[] = [];

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  /** Open an existing ledger file read-back (e.g. to settle a finished run). */
  static load(filePath: string): Ledger {
    const ledger = new Ledger(filePath);
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as LoggedLedgerEntry;
        ledger.entries.push(entry);
        ledger.seq = Math.max(ledger.seq, entry.seq);
      }
    }
    return ledger;
  }

  append(entry: LedgerEntry): void {
    this.seq += 1;
    const logged: LoggedLedgerEntry = { ...entry, seq: this.seq, ts: new Date().toISOString() };
    appendFileSync(this.filePath, `${JSON.stringify(logged)}\n`, "utf8");
    this.entries.push(logged);
  }

  all(): readonly LoggedLedgerEntry[] {
    return this.entries;
  }

  buyIns(): Map<string, number> {
    const map = new Map<string, number>();
    for (const entry of this.entries) {
      if (entry.kind === "buy_in") {
        map.set(entry.playerId, (map.get(entry.playerId) ?? 0) + entry.tokens);
      }
    }
    return map;
  }

  /**
   * Net token result per player: settled hand deltas minus burned thinking
   * cost (when the burn rule is on, burns are part of your result).
   */
  netDeltas(): Map<string, number> {
    const map = new Map<string, number>();
    for (const entry of this.entries) {
      if (entry.kind === "hand_delta") {
        map.set(entry.playerId, (map.get(entry.playerId) ?? 0) + entry.tokens);
      } else if (entry.kind === "burn") {
        map.set(entry.playerId, (map.get(entry.playerId) ?? 0) - entry.tokens);
      }
    }
    return map;
  }

  /** Total tokens burned per player under thinkingBurnsStack. */
  burns(): Map<string, number> {
    const map = new Map<string, number>();
    for (const entry of this.entries) {
      if (entry.kind === "burn") {
        map.set(entry.playerId, (map.get(entry.playerId) ?? 0) + entry.tokens);
      }
    }
    return map;
  }

  inferenceTotalsUsd(): Map<string, number> {
    const map = new Map<string, number>();
    for (const entry of this.entries) {
      if (entry.kind === "inference_spend") {
        map.set(entry.playerId, (map.get(entry.playerId) ?? 0) + entry.usd);
      }
    }
    return map;
  }

  /** Poker moves chips, it never creates them: per-hand deltas must sum to zero. */
  assertHandConservation(handNo: number): void {
    let sum = 0;
    for (const entry of this.entries) {
      if (entry.kind === "hand_delta" && entry.handNo === handNo) sum += entry.tokens;
    }
    if (sum !== 0) {
      throw new Error(`hand ${handNo} deltas sum to ${sum}, expected 0`);
    }
  }

  /**
   * Who owes whom, greedy netting: losers' debts matched against winners'
   * claims largest-first. Social settlement — this is Tier 0.
   */
  settlementPairs(): ReadonlyArray<{ from: string; to: string; tokens: number }> {
    const deltas = this.netDeltas();
    const winners = [...deltas.entries()]
      .filter(([, tokens]) => tokens > 0)
      .map(([playerId, tokens]) => ({ playerId, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
    const losers = [...deltas.entries()]
      .filter(([, tokens]) => tokens < 0)
      .map(([playerId, tokens]) => ({ playerId, tokens: -tokens }))
      .sort((a, b) => b.tokens - a.tokens);

    const pairs: Array<{ from: string; to: string; tokens: number }> = [];
    let wi = 0;
    let li = 0;
    while (wi < winners.length && li < losers.length) {
      const winner = winners[wi];
      const loser = losers[li];
      if (!winner || !loser) break;
      const amount = Math.min(winner.tokens, loser.tokens);
      if (amount > 0) pairs.push({ from: loser.playerId, to: winner.playerId, tokens: amount });
      winner.tokens -= amount;
      loser.tokens -= amount;
      if (winner.tokens === 0) wi += 1;
      if (loser.tokens === 0) li += 1;
    }
    return pairs;
  }
}
