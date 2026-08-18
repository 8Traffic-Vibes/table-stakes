import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardToString, type DomainEvent } from "@hivetech/poker-engine";
import { commitment, deriveDeck } from "../src/dealing.ts";
import { TableRunner } from "../src/runner.ts";
import { verifyRunEvents, verifyRunFile } from "../src/verify.ts";

const serverSeed = "a".repeat(64);
const seeds = [
  { playerId: "alice", seed: "1111" },
  { playerId: "bob", seed: "2222" },
  { playerId: "carol", seed: "3333" },
];
const handNo = 1;

/**
 * Play one real scripted check/call hand through the engine and log it the
 * way runSession would: commit, seeds, engine events, reveal, settlement.
 */
function playSessionEvents(): Array<Record<string, unknown>> {
  const deck = deriveDeck({ serverSeed, clientSeeds: seeds.map((s) => s.seed), nonce: handNo });
  const runner = new TableRunner({ smallBlind: 5, bigBlind: 10, minBuyIn: 1_000 });
  runner.seatPlayer("alice", 1_000);
  runner.seatPlayer("bob", 1_000);
  runner.seatPlayer("carol", 1_000);

  const engineEvents: DomainEvent[] = [...runner.startHand(deck)];
  let guard = 0;
  while (runner.handActive() && guard < 50) {
    guard += 1;
    const playerId = runner.currentActorId();
    if (!playerId) break;
    const legal = runner.legalFor(playerId);
    const action = legal.some((a) => a.kind === "check")
      ? ({ kind: "check" } as const)
      : ({ kind: "call" } as const);
    engineEvents.push(...runner.act(playerId, action));
  }

  const deltas: Record<string, number> = {};
  for (const [playerId, stack] of Object.entries(runner.stacks())) {
    if (stack !== 1_000) deltas[playerId] = stack - 1_000;
  }

  let seq = 0;
  const line = (event: Record<string, unknown>): Record<string, unknown> => ({
    ...event,
    seq: (seq += 1),
    ts: "2026-01-01T00:00:00.000Z",
  });
  const lines = [
    line({ type: "deck_committed", handNo, commit: commitment(serverSeed) }),
    line({ type: "seeds_collected", handNo, seeds, drawnBy: "table" }),
    ...engineEvents.map((event) => line({ type: "engine_event", handNo, event })),
    line({ type: "seed_revealed", handNo, serverSeed, deckCodes: deck.map(cardToString) }),
    line({ type: "hand_settled", handNo, deltasTokens: deltas, inferenceUsd: {} }),
  ];
  // Round-trip through JSON, exactly like reading events.jsonl back from disk.
  return lines.map((l) => JSON.parse(JSON.stringify(l)) as Record<string, unknown>);
}

const engineEventOf = (line: Record<string, unknown>): Record<string, unknown> | null => {
  const event = line["event"];
  return typeof event === "object" && event !== null ? (event as Record<string, unknown>) : null;
};

describe("verifyRunEvents", () => {
  it("verifies an honest run", () => {
    const result = verifyRunEvents(playSessionEvents());
    expect(result.reasons).toEqual([]);
    expect(result.handsChecked).toBe(1);
    expect(result.hands[0]).toMatchObject({
      handNo: 1,
      ok: true,
      commitOk: true,
      dealOk: true,
      conservationOk: true,
    });
    expect(result.ok).toBe(true);
  });

  it("catches a tampered hole card in the engine events", () => {
    const events = playSessionEvents();
    const holeLine = events.find(
      (e) => e["type"] === "engine_event" && engineEventOf(e)?.["type"] === "hole-cards-dealt",
    );
    expect(holeLine).toBeDefined();
    const cards = engineEventOf(holeLine as Record<string, unknown>)?.["cards"] as unknown[];
    cards.reverse(); // swap the two hole cards: same cards, wrong deal order

    const result = verifyRunEvents(events);
    expect(result.ok).toBe(false);
    expect(result.hands[0]?.dealOk).toBe(false);
    expect(result.hands[0]?.commitOk).toBe(true);
    expect(result.hands[0]?.reasons.join(" ")).toContain("hole cards");
  });

  it("catches a wrong commitment", () => {
    const events = playSessionEvents();
    const committed = events.find((e) => e["type"] === "deck_committed");
    expect(committed).toBeDefined();
    (committed as Record<string, unknown>)["commit"] = commitment("b".repeat(64));

    const result = verifyRunEvents(events);
    expect(result.ok).toBe(false);
    expect(result.hands[0]?.commitOk).toBe(false);
    expect(result.hands[0]?.reasons.join(" ")).toContain("commitment");
  });

  it("catches unbalanced settlement deltas", () => {
    const events = playSessionEvents();
    const settled = events.find((e) => e["type"] === "hand_settled");
    expect(settled).toBeDefined();
    const deltas = (settled as Record<string, unknown>)["deltasTokens"] as Record<string, number>;
    deltas["alice"] = (deltas["alice"] ?? 0) + 5;

    const result = verifyRunEvents(events);
    expect(result.ok).toBe(false);
    expect(result.hands[0]?.conservationOk).toBe(false);
    expect(result.hands[0]?.reasons.join(" ")).toContain("sum");
  });

  it("flags a commitment whose seed was never revealed", () => {
    const events = playSessionEvents().filter((e) => e["type"] !== "seed_revealed");
    const result = verifyRunEvents(events);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("orphan");
    expect(result.hands[0]?.ok).toBe(false);
  });

  it("flags a non-increasing seq", () => {
    const events = playSessionEvents();
    (events[2] as Record<string, unknown>)["seq"] = 1;
    const result = verifyRunEvents(events);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("seq");
  });
});

describe("verifyRunFile", () => {
  it("verifies a run straight from a JSONL file, skipping blank lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "table-stakes-verify-"));
    const path = join(dir, "events.jsonl");
    const body = playSessionEvents()
      .map((e) => JSON.stringify(e))
      .join("\n");
    writeFileSync(path, `${body}\n\n`, "utf8");

    const result = verifyRunFile(path);
    expect(result.ok).toBe(true);
    expect(result.handsChecked).toBe(1);
  });
});
