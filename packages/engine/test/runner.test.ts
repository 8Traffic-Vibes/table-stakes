import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@hivetech/poker-engine";
import { deriveDeck } from "../src/dealing.ts";
import { TableRunner } from "../src/runner.ts";

const fixedDeck = () =>
  deriveDeck({ serverSeed: "c".repeat(64), clientSeeds: ["s1", "s2"], nonce: 1 });

function setupHeadsUp(): { runner: TableRunner; events: DomainEvent[] } {
  const runner = new TableRunner({ smallBlind: 5, bigBlind: 10, minBuyIn: 1_000 });
  const events: DomainEvent[] = [];
  events.push(...runner.seatPlayer("alice", 1_000));
  events.push(...runner.seatPlayer("bob", 1_000));
  events.push(...runner.startHand(fixedDeck()));
  return { runner, events };
}

describe("TableRunner", () => {
  it("plays a fold hand: small blind folds, big blind collects", () => {
    const { runner } = setupHeadsUp();
    const actor = runner.currentActorId();
    expect(actor).not.toBeNull();
    runner.act(actor as string, { kind: "fold" });

    expect(runner.handActive()).toBe(false);
    const stacks = runner.stacks();
    const total = Object.values(stacks).reduce((a, b) => a + b, 0);
    expect(total).toBe(2_000);
    const deltas = Object.values(stacks).map((s) => s - 1_000).sort((a, b) => a - b);
    expect(deltas).toEqual([-5, 5]);
  });

  it("reaches showdown when both players check it down", () => {
    const { runner } = setupHeadsUp();
    const allEvents: DomainEvent[] = [];
    let guard = 0;
    while (runner.handActive()) {
      guard += 1;
      expect(guard).toBeLessThan(50);
      const playerId = runner.currentActorId();
      if (!playerId) break;
      const legal = runner.legalFor(playerId);
      const call = legal.find((a) => a.kind === "call");
      const check = legal.find((a) => a.kind === "check");
      const action = check ? ({ kind: "check" } as const) : ({ kind: "call" } as const);
      expect(call ?? check).toBeDefined();
      allEvents.push(...runner.act(playerId, action));
    }

    const completed = allEvents.find((e) => e.type === "hand-completed");
    expect(completed).toBeDefined();
    if (completed?.type === "hand-completed") {
      expect(completed.reason).toBe("showdown");
    }
    expect(allEvents.some((e) => e.type === "cards-revealed")).toBe(true);

    const total = Object.values(runner.stacks()).reduce((a, b) => a + b, 0);
    expect(total).toBe(2_000);
  });

  it("replays its command log to the identical state", () => {
    const { runner } = setupHeadsUp();
    const actor = runner.currentActorId();
    runner.act(actor as string, { kind: "fold" });
    expect(() => runner.assertReplayable()).not.toThrow();
  });
});
