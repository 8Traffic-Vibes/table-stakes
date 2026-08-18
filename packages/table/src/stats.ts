/**
 * Per-player session stats derived from a run's parsed events.jsonl lines.
 *
 * Input lines are treated as untrusted (LoggedEvent-shaped, but narrowed
 * defensively): poker stats come from the raw engine events, table stats
 * (decisions, cost, chat) from the table-level log entries.
 */

export interface PlayerStats {
  readonly handsDealt: number;
  /** Sum of positive settlement deltas — tokens dragged, not net. */
  readonly handsWonTokens: number;
  /** Fraction 0..1 of dealt hands with a voluntary preflop call/bet/raise. */
  readonly vpip: number;
  /** Fraction 0..1 of dealt hands with a preflop bet/raise. */
  readonly pfr: number;
  readonly decisions: number;
  readonly fallbacks: number;
  readonly totalCostUsd: number;
  readonly avgCostPerDecisionUsd: number;
  readonly chatLines: number;
  readonly reactions: number;
}

interface StatsAccumulator {
  handsDealt: number;
  handsWonTokens: number;
  vpipHands: Set<number>;
  pfrHands: Set<number>;
  decisions: number;
  fallbacks: number;
  totalCostUsd: number;
  chatLines: number;
  reactions: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const VPIP_KINDS = new Set(["call", "bet-to", "raise-to"]);
const PFR_KINDS = new Set(["bet-to", "raise-to"]);

export function computeStats(
  events: ReadonlyArray<Record<string, unknown>>,
): Map<string, PlayerStats> {
  const accumulators = new Map<string, StatsAccumulator>();
  /** Hands whose first street has been dealt — later actions are postflop. */
  const pastPreflop = new Set<number>();

  const ensure = (playerId: string): StatsAccumulator => {
    const existing = accumulators.get(playerId);
    if (existing) return existing;
    const fresh: StatsAccumulator = {
      handsDealt: 0,
      handsWonTokens: 0,
      vpipHands: new Set(),
      pfrHands: new Set(),
      decisions: 0,
      fallbacks: 0,
      totalCostUsd: 0,
      chatLines: 0,
      reactions: 0,
    };
    accumulators.set(playerId, fresh);
    return fresh;
  };

  for (const line of events) {
    const type = asString(line["type"]);

    if (type === "engine_event") {
      const handNo = asNumber(line["handNo"]);
      const event = line["event"];
      if (handNo === null || !isRecord(event)) continue;
      const eventType = asString(event["type"]);
      if (eventType === "street-dealt") {
        pastPreflop.add(handNo);
      } else if (eventType === "hole-cards-dealt") {
        const playerId = asString(event["playerId"]);
        if (playerId !== null) ensure(playerId).handsDealt += 1;
      } else if (eventType === "player-acted" && !pastPreflop.has(handNo)) {
        const playerId = asString(event["playerId"]);
        const action = event["action"];
        const kind = isRecord(action) ? asString(action["kind"]) : null;
        if (playerId === null || kind === null) continue;
        const stats = ensure(playerId);
        if (VPIP_KINDS.has(kind)) stats.vpipHands.add(handNo);
        if (PFR_KINDS.has(kind)) stats.pfrHands.add(handNo);
      }
      continue;
    }

    if (type === "action_decided") {
      const playerId = asString(line["playerId"]);
      if (playerId === null) continue;
      const stats = ensure(playerId);
      stats.decisions += 1;
      if (typeof line["fallback"] === "string") stats.fallbacks += 1;
      const inference = line["inference"];
      const costUsd = isRecord(inference) ? asNumber(inference["costUsd"]) : null;
      if (costUsd !== null) stats.totalCostUsd += costUsd;
      continue;
    }

    if (type === "hand_settled") {
      const deltas = line["deltasTokens"];
      if (!isRecord(deltas)) continue;
      for (const [playerId, delta] of Object.entries(deltas)) {
        const tokens = asNumber(delta);
        if (tokens !== null && tokens > 0) ensure(playerId).handsWonTokens += tokens;
      }
      continue;
    }

    if (type === "chat_said") {
      const playerId = asString(line["playerId"]);
      if (playerId !== null) ensure(playerId).chatLines += 1;
      continue;
    }

    if (type === "reaction_added") {
      const playerId = asString(line["playerId"]);
      if (playerId !== null) ensure(playerId).reactions += 1;
    }
  }

  const stats = new Map<string, PlayerStats>();
  for (const [playerId, acc] of accumulators) {
    stats.set(playerId, {
      handsDealt: acc.handsDealt,
      handsWonTokens: acc.handsWonTokens,
      vpip: acc.handsDealt > 0 ? acc.vpipHands.size / acc.handsDealt : 0,
      pfr: acc.handsDealt > 0 ? acc.pfrHands.size / acc.handsDealt : 0,
      decisions: acc.decisions,
      fallbacks: acc.fallbacks,
      totalCostUsd: acc.totalCostUsd,
      avgCostPerDecisionUsd: acc.decisions > 0 ? acc.totalCostUsd / acc.decisions : 0,
      chatLines: acc.chatLines,
      reactions: acc.reactions,
    });
  }
  return stats;
}

/** Compact markdown table of the session stats, for summary.md. */
export function formatStatsTable(
  stats: Map<string, PlayerStats>,
  nameOf: (playerId: string) => string,
): string {
  const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;
  const rows = [...stats.entries()].map(
    ([playerId, s]) =>
      `| ${nameOf(playerId)} | ${s.handsDealt} | ${s.handsWonTokens} | ${pct(s.vpip)} | ${pct(s.pfr)} | ${s.decisions} | ${s.fallbacks} | $${s.totalCostUsd.toFixed(6)} | $${s.avgCostPerDecisionUsd.toFixed(6)} | ${s.chatLines} | ${s.reactions} |`,
  );
  return [
    "| Player | Hands | Won (tokens) | VPIP | PFR | Decisions | Fallbacks | Cost | $/decision | Chat | Reactions |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
}
