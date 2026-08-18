import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaims, ClaimsStore } from "../src/claims.ts";
import type { Peg } from "../src/pricing.ts";

const peg: Peg = {
  referenceModel: "test/model",
  tokensPerChip: 1_000,
  usdPerToken: 0.000001,
  frozenAt: "2026-08-18T00:00:00.000Z",
};

const newStorePath = () => join(mkdtempSync(join(tmpdir(), "claims-")), "claims.jsonl");

describe("buildClaims", () => {
  it("caps each claim at the pegged USD value of its tokens", () => {
    const claims = buildClaims(
      [
        { from: "a", to: "b", tokens: 50_000 },
        { from: "a", to: "c", tokens: 10_000 },
      ],
      peg,
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      id: "claim-1-a-b",
      from: "a",
      to: "b",
      tokens: 50_000,
      usdRedeemed: 0,
      status: "open",
    });
    expect(claims[0]?.usdCap).toBeCloseTo(0.05);
    expect(claims[1]?.id).toBe("claim-2-a-c");
    expect(claims[1]?.usdCap).toBeCloseTo(0.01);
  });
});

describe("ClaimsStore", () => {
  it("folds redemptions and flips to exhausted at the cap", () => {
    const store = new ClaimsStore(newStorePath());
    store.create(buildClaims([{ from: "a", to: "b", tokens: 50_000 }], peg));
    store.redeem("claim-1-a-b", 0.01, "gen-1");
    store.redeem("claim-1-a-b", 0.02);
    let claim = store.get("claim-1-a-b");
    expect(claim?.usdRedeemed).toBeCloseTo(0.03);
    expect(claim?.status).toBe("open");

    store.redeem("claim-1-a-b", 0.02, "gen-2");
    claim = store.get("claim-1-a-b");
    expect(claim?.usdRedeemed).toBeCloseTo(0.05);
    expect(claim?.status).toBe("exhausted");
  });

  it("reloads folded state from disk", () => {
    const path = newStorePath();
    const store = new ClaimsStore(path);
    store.create(buildClaims([{ from: "a", to: "b", tokens: 50_000 }], peg));
    store.redeem("claim-1-a-b", 0.01, "gen-1");
    const reloaded = new ClaimsStore(path);
    expect(reloaded.get("claim-1-a-b")?.usdRedeemed).toBeCloseTo(0.01);
    expect(reloaded.all()).toEqual(store.all());
  });

  it("keeps defaulted sticky over later redemptions", () => {
    const store = new ClaimsStore(newStorePath());
    store.create(buildClaims([{ from: "a", to: "b", tokens: 50_000 }], peg));
    store.markDefaulted("claim-1-a-b", "staked key revoked or exhausted (402)");
    store.redeem("claim-1-a-b", 0.05);
    expect(store.get("claim-1-a-b")?.status).toBe("defaulted");
  });

  it("returns null for unknown claims", () => {
    const store = new ClaimsStore(newStorePath());
    store.create(buildClaims([{ from: "a", to: "b", tokens: 1_000 }], peg));
    expect(store.get("claim-404")).toBeNull();
  });
});
