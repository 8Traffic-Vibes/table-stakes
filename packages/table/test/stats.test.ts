import { describe, expect, it } from "vitest";
import { computeStats, formatStatsTable } from "../src/stats.ts";

let seq = 0;
const line = (event: Record<string, unknown>): Record<string, unknown> => ({
  ...event,
  seq: (seq += 1),
  ts: "2026-01-01T00:00:00.000Z",
});
const engine = (handNo: number, event: Record<string, unknown>): Record<string, unknown> =>
  line({ type: "engine_event", handNo, event });

/**
 * Two players, two hands.
 * Hand 1: alice (SB) calls preflop (VPIP, not PFR), bob (BB) checks behind on
 * a fallback (blind alone must NOT count as VPIP); alice bets the flop
 * (postflop, so no VPIP/PFR credit); alice chats, bob reacts; alice wins 20.
 * Hand 2: bob raises preflop (VPIP + PFR), alice folds her blind; bob wins 15.
 */
const events: Array<Record<string, unknown>> = [
  // Hand 1
  engine(1, { type: "hand-started", handNumber: 1 }),
  engine(1, { type: "forced-bet-posted", playerId: "alice", kind: "small-blind", amount: 5 }),
  engine(1, { type: "forced-bet-posted", playerId: "bob", kind: "big-blind", amount: 10 }),
  engine(1, { type: "hole-cards-dealt", playerId: "alice" }),
  engine(1, { type: "hole-cards-dealt", playerId: "bob" }),
  line({
    type: "action_decided",
    handNo: 1,
    playerId: "alice",
    action: { kind: "call" },
    inference: { costUsd: 0.002 },
  }),
  engine(1, { type: "player-acted", playerId: "alice", action: { kind: "call" } }),
  line({
    type: "action_decided",
    handNo: 1,
    playerId: "bob",
    action: { kind: "check" },
    fallback: "seat timed out",
  }),
  engine(1, { type: "player-acted", playerId: "bob", action: { kind: "check" } }),
  engine(1, { type: "street-dealt", street: "flop" }),
  line({
    type: "action_decided",
    handNo: 1,
    playerId: "alice",
    action: { kind: "bet-to", amount: 30 },
    inference: { costUsd: 0.004 },
  }),
  engine(1, { type: "player-acted", playerId: "alice", action: { kind: "bet-to", amount: 30 } }),
  line({ type: "chat_said", handNo: 1, playerId: "alice", text: "nice flop" }),
  line({ type: "reaction_added", handNo: 1, playerId: "bob", emoji: "🔥" }),
  line({ type: "hand_settled", handNo: 1, deltasTokens: { alice: 20, bob: -20 }, inferenceUsd: {} }),
  // Hand 2
  engine(2, { type: "hand-started", handNumber: 2 }),
  engine(2, { type: "forced-bet-posted", playerId: "bob", kind: "small-blind", amount: 5 }),
  engine(2, { type: "forced-bet-posted", playerId: "alice", kind: "big-blind", amount: 10 }),
  engine(2, { type: "hole-cards-dealt", playerId: "alice" }),
  engine(2, { type: "hole-cards-dealt", playerId: "bob" }),
  line({
    type: "action_decided",
    handNo: 2,
    playerId: "bob",
    action: { kind: "raise-to", amount: 30 },
    inference: { costUsd: 0.001 },
  }),
  engine(2, { type: "player-acted", playerId: "bob", action: { kind: "raise-to", amount: 30 } }),
  line({ type: "action_decided", handNo: 2, playerId: "alice", action: { kind: "fold" } }),
  engine(2, { type: "player-acted", playerId: "alice", action: { kind: "fold" } }),
  line({ type: "hand_settled", handNo: 2, deltasTokens: { bob: 15, alice: -15 }, inferenceUsd: {} }),
];

describe("computeStats", () => {
  const stats = computeStats(events);

  it("counts dealt hands per player", () => {
    expect(stats.get("alice")?.handsDealt).toBe(2);
    expect(stats.get("bob")?.handsDealt).toBe(2);
  });

  it("counts a voluntary preflop call as VPIP, but not blinds or postflop bets", () => {
    // Alice: VPIP only in hand 1 (the call); her hand-1 flop bet and hand-2
    // big blind must not count.
    expect(stats.get("alice")?.vpip).toBe(0.5);
    expect(stats.get("alice")?.pfr).toBe(0);
  });

  it("counts a preflop raise as both VPIP and PFR", () => {
    // Bob: hand-1 big blind + check gives no credit; hand-2 raise gives both.
    expect(stats.get("bob")?.vpip).toBe(0.5);
    expect(stats.get("bob")?.pfr).toBe(0.5);
  });

  it("counts decisions, fallbacks, and averages cost per decision", () => {
    const alice = stats.get("alice");
    expect(alice?.decisions).toBe(3);
    expect(alice?.fallbacks).toBe(0);
    expect(alice?.totalCostUsd).toBeCloseTo(0.006, 12);
    expect(alice?.avgCostPerDecisionUsd).toBeCloseTo(0.002, 12);

    const bob = stats.get("bob");
    expect(bob?.decisions).toBe(2);
    expect(bob?.fallbacks).toBe(1);
    expect(bob?.totalCostUsd).toBeCloseTo(0.001, 12);
    expect(bob?.avgCostPerDecisionUsd).toBeCloseTo(0.0005, 12);
  });

  it("sums only positive settlement deltas as tokens won", () => {
    expect(stats.get("alice")?.handsWonTokens).toBe(20);
    expect(stats.get("bob")?.handsWonTokens).toBe(15);
  });

  it("counts chat lines and reactions", () => {
    expect(stats.get("alice")?.chatLines).toBe(1);
    expect(stats.get("alice")?.reactions).toBe(0);
    expect(stats.get("bob")?.chatLines).toBe(0);
    expect(stats.get("bob")?.reactions).toBe(1);
  });
});

describe("formatStatsTable", () => {
  it("renders a markdown table with display names", () => {
    const stats = computeStats(events);
    const table = formatStatsTable(stats, (playerId) =>
      playerId === "alice" ? "Alice" : "Bob",
    );
    const lines = table.split("\n");
    expect(lines[0]).toContain("VPIP");
    expect(lines[1]).toContain("---");
    expect(table).toContain("| Alice | 2 | 20 | 50% | 0% | 3 | 0 |");
    expect(table).toContain("| Bob | 2 | 15 | 50% | 50% | 2 | 1 |");
  });
});
