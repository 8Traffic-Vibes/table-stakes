import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@hivetech/poker-engine";
import { deriveDeck } from "../src/dealing.ts";
import { handToPhh } from "../src/phh.ts";
import { TableRunner } from "../src/runner.ts";

function playFoldHand(): { events: DomainEvent[] } {
  const runner = new TableRunner({ smallBlind: 5, bigBlind: 10, minBuyIn: 1_000 });
  const events: DomainEvent[] = [];
  runner.seatPlayer("alice", 1_000);
  runner.seatPlayer("bob", 1_000);
  events.push(
    ...runner.startHand(
      deriveDeck({ serverSeed: "d".repeat(64), clientSeeds: ["x", "y"], nonce: 1 }),
    ),
  );
  events.push(...runner.act(runner.currentActorId() as string, { kind: "fold" }));
  return { events };
}

describe("PHH export", () => {
  it("emits a well-formed .phh hand with blinds, stacks, and actions", () => {
    const { events } = playFoldHand();
    const phh = handToPhh({
      handNo: 3,
      smallBlind: 5,
      bigBlind: 10,
      players: [
        { playerId: "alice", name: "Alice", startingStack: 1_000 },
        { playerId: "bob", name: "Bob", startingStack: 1_000 },
      ],
      events,
      chat: [{ afterAction: 0, playerName: "Bob", text: "gl" }],
    });

    expect(phh).toContain(`variant = "NT"`);
    expect(phh).toContain(`min_bet = 10`);
    expect(phh).toContain(`hand = 3`);
    expect(phh).toContain(`starting_stacks = [1000, 1000]`);
    // Heads-up phh-std: file stores [sb, bb]; parsers reverse-assign, so
    // p1 must be the big-blind poster and p2 the small blind/button.
    expect(phh).toContain(`blinds_or_straddles = [5, 10]`);
    // Two hole-card deals; the folder is the small blind = p2.
    expect(phh.match(/d dh p\d/g)?.length).toBe(2);
    expect(phh).toContain(`"p2 f`);
    // Table talk rides as commentary.
    expect(phh).toContain(`# Bob: gl`);
  });
});
