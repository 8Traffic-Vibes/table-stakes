import { describe, expect, it } from "vitest";
import { cardToString, type DomainEvent } from "@hivetech/poker-engine";
import { commitment, deriveDeck, verifyDeal, verifyHandDealing } from "../src/dealing.ts";
import { TableRunner } from "../src/runner.ts";

const input = {
  serverSeed: "a".repeat(64),
  clientSeeds: ["1111", "2222", "3333"],
  nonce: 7,
};

describe("commit-reveal dealing", () => {
  it("derives the same deck for the same inputs", () => {
    const a = deriveDeck(input).map(cardToString);
    const b = deriveDeck(input).map(cardToString);
    expect(a).toEqual(b);
  });

  it("produces a complete 52-card deck", () => {
    const deck = deriveDeck(input).map(cardToString);
    expect(new Set(deck).size).toBe(52);
  });

  it("changes the deck when the nonce changes", () => {
    const a = deriveDeck(input).map(cardToString);
    const b = deriveDeck({ ...input, nonce: 8 }).map(cardToString);
    expect(a).not.toEqual(b);
  });

  it("changes the deck when a client seed changes", () => {
    const a = deriveDeck(input).map(cardToString);
    const b = deriveDeck({ ...input, clientSeeds: ["1111", "2222", "9999"] }).map(cardToString);
    expect(a).not.toEqual(b);
  });

  it("verifies an honest deal", () => {
    const deckCodes = deriveDeck(input).map(cardToString);
    const result = verifyDeal({
      commit: commitment(input.serverSeed),
      serverSeed: input.serverSeed,
      clientSeeds: input.clientSeeds,
      nonce: input.nonce,
      deckCodes,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong commitment", () => {
    const deckCodes = deriveDeck(input).map(cardToString);
    const result = verifyDeal({
      commit: commitment("b".repeat(64)),
      serverSeed: input.serverSeed,
      clientSeeds: input.clientSeeds,
      nonce: input.nonce,
      deckCodes,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("commitment");
  });

  it("verifies actual dealt cards against the deck (non-circular check)", () => {
    const deck = deriveDeck(input);
    const runner = new TableRunner({ smallBlind: 5, bigBlind: 10, minBuyIn: 1_000 });
    runner.seatPlayer("alice", 1_000);
    runner.seatPlayer("bob", 1_000);
    runner.seatPlayer("carol", 1_000);
    const events: DomainEvent[] = [...runner.startHand(deck)];
    // Check the whole hand down to showdown so streets get verified too.
    let guard = 0;
    while (runner.handActive() && guard < 50) {
      guard += 1;
      const playerId = runner.currentActorId();
      if (!playerId) break;
      const legal = runner.legalFor(playerId);
      const action = legal.some((a) => a.kind === "check")
        ? ({ kind: "check" } as const)
        : ({ kind: "call" } as const);
      events.push(...runner.act(playerId, action));
    }
    const deckCodes = deck.map(cardToString);
    expect(verifyHandDealing(deckCodes, events).ok).toBe(true);

    // A hand dealt from a DIFFERENT deck must fail against this deck record.
    const otherDeck = deriveDeck({ ...input, nonce: 99 });
    expect(verifyHandDealing(otherDeck.map(cardToString), events).ok).toBe(false);
  });

  it("rejects a tampered deck", () => {
    const deckCodes = deriveDeck(input).map(cardToString);
    const swapped = [...deckCodes];
    const a = swapped[0] as string;
    swapped[0] = swapped[51] as string;
    swapped[51] = a;
    const result = verifyDeal({
      commit: commitment(input.serverSeed),
      serverSeed: input.serverSeed,
      clientSeeds: input.clientSeeds,
      nonce: input.nonce,
      deckCodes: swapped,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("deck");
  });
});
