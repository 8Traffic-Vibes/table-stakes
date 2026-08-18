import { describe, expect, it } from "vitest";
import type { LegalAction } from "@table-stakes/engine";
import { extractJsonObjects, resolveAction } from "../src/seats/model.ts";

describe("extractJsonObjects", () => {
  it("finds JSON in prose and code fences", () => {
    const text = 'Thinking...\n```json\n{"action": "call"}\n```\nDone.';
    expect(extractJsonObjects(text)).toEqual([{ action: "call" }]);
  });

  it("handles braces inside strings", () => {
    const text = '{"action": "raise", "amount": 500, "say": "gg {friend}"}';
    expect(extractJsonObjects(text)).toEqual([
      { action: "raise", amount: 500, say: "gg {friend}" },
    ]);
  });

  it("returns multiple objects in order", () => {
    const text = '{"a":1} then {"action":"fold"}';
    expect(extractJsonObjects(text)).toHaveLength(2);
  });

  it("ignores malformed blocks", () => {
    expect(extractJsonObjects("{not json} {\"action\":\"check\"}")).toEqual([
      { action: "check" },
    ]);
  });

  it("recovers after an unmatched open brace in prose", () => {
    const text = 'pot odds { are rough here... final answer: {"action":"fold"}';
    expect(extractJsonObjects(text)).toContainEqual({ action: "fold" });
  });
});

const facingBet: LegalAction[] = [
  { kind: "fold" },
  { kind: "call", amount: 400 },
  { kind: "raise-to", minAmount: 800, maxAmount: 10_000 },
];
const openAction: LegalAction[] = [
  { kind: "fold" },
  { kind: "check" },
  { kind: "bet-to", minAmount: 200, maxAmount: 10_000 },
];

describe("resolveAction", () => {
  it("passes through legal actions", () => {
    expect(resolveAction({ kind: "call" }, facingBet).action).toEqual({ kind: "call" });
    expect(resolveAction({ kind: "fold" }, facingBet).action).toEqual({ kind: "fold" });
    expect(resolveAction({ kind: "check" }, openAction).action).toEqual({ kind: "check" });
  });

  it("treats a 'raise' at or below the call amount as a call", () => {
    const low = resolveAction({ kind: "raise", amount: 100 }, facingBet);
    expect(low.action).toEqual({ kind: "call" });
    expect(low.adjusted).toContain("not above the call");
  });

  it("clamps genuine raise intents into the legal range", () => {
    const between = resolveAction({ kind: "raise", amount: 500 }, facingBet);
    expect(between.action).toEqual({ kind: "raise-to", amount: 800 });
    expect(between.adjusted).toContain("clamped");

    const high = resolveAction({ kind: "raise", amount: 999_999 }, facingBet);
    expect(high.action).toEqual({ kind: "raise-to", amount: 10_000 });
  });

  it("maps bet onto bet-to when opening", () => {
    expect(resolveAction({ kind: "bet", amount: 600 }, openAction).action).toEqual({
      kind: "bet-to",
      amount: 600,
    });
  });

  it("treats all-in as max bet/raise", () => {
    expect(resolveAction({ kind: "all-in" }, facingBet).action).toEqual({
      kind: "raise-to",
      amount: 10_000,
    });
  });

  it("turns a free fold into a check", () => {
    const result = resolveAction({ kind: "fold" }, openAction);
    expect(result.action).toEqual({ kind: "check" });
    expect(result.adjusted).toContain("free");
  });

  it("turns call into check when nothing to call", () => {
    expect(resolveAction({ kind: "call" }, openAction).action).toEqual({ kind: "check" });
  });

  it("falls back to check-or-fold on nonsense", () => {
    const open = resolveAction({ kind: "cheat" }, openAction);
    expect(open.action).toEqual({ kind: "check" });
    expect(open.fallback).toBeDefined();

    const facing = resolveAction({ kind: "cheat" }, facingBet);
    expect(facing.action).toEqual({ kind: "fold" });
  });

  it("degrades a raise without amount to a call", () => {
    const result = resolveAction({ kind: "raise" }, facingBet);
    expect(result.action).toEqual({ kind: "call" });
    expect(result.adjusted).toBeDefined();
  });
});
