import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";

const newLedger = () => new Ledger(join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"));

describe("Ledger", () => {
  it("tracks buy-ins and net deltas", () => {
    const ledger = newLedger();
    ledger.append({ kind: "buy_in", playerId: "a", tokens: 200_000 });
    ledger.append({ kind: "buy_in", playerId: "b", tokens: 200_000 });
    ledger.append({ kind: "hand_delta", handNo: 1, playerId: "a", tokens: -5_000 });
    ledger.append({ kind: "hand_delta", handNo: 1, playerId: "b", tokens: 5_000 });
    expect(ledger.buyIns().get("a")).toBe(200_000);
    expect(ledger.netDeltas().get("a")).toBe(-5_000);
    expect(() => ledger.assertHandConservation(1)).not.toThrow();
  });

  it("catches non-conserved hands", () => {
    const ledger = newLedger();
    ledger.append({ kind: "hand_delta", handNo: 2, playerId: "a", tokens: -5_000 });
    ledger.append({ kind: "hand_delta", handNo: 2, playerId: "b", tokens: 4_000 });
    expect(() => ledger.assertHandConservation(2)).toThrow("sum to -1000");
  });

  it("nets settlements greedily, largest first", () => {
    const ledger = newLedger();
    ledger.append({ kind: "hand_delta", handNo: 1, playerId: "a", tokens: -300 });
    ledger.append({ kind: "hand_delta", handNo: 1, playerId: "b", tokens: 100 });
    ledger.append({ kind: "hand_delta", handNo: 1, playerId: "c", tokens: 200 });
    expect(ledger.settlementPairs()).toEqual([
      { from: "a", to: "c", tokens: 200 },
      { from: "a", to: "b", tokens: 100 },
    ]);
  });

  it("sums inference spend per player", () => {
    const ledger = newLedger();
    ledger.append({ kind: "inference_spend", handNo: 1, playerId: "a", usd: 0.001 });
    ledger.append({ kind: "inference_spend", handNo: 2, playerId: "a", usd: 0.002 });
    expect(ledger.inferenceTotalsUsd().get("a")).toBeCloseTo(0.003);
  });
});
