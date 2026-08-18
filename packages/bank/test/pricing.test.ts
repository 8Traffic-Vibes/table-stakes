import { describe, expect, it } from "vitest";
import {
  formatTokens,
  freezePeg,
  tokensToChips,
  tokensToUsd,
  usdToTokens,
  type Peg,
} from "../src/pricing.ts";
import type { OpenRouterClient } from "../src/openrouter.ts";

const peg: Peg = {
  referenceModel: "test/model",
  tokensPerChip: 1_000,
  usdPerToken: 0.000001,
  frozenAt: "2026-08-18T00:00:00.000Z",
};

describe("peg conversions", () => {
  it("converts tokens to USD and back", () => {
    expect(tokensToUsd(1_000_000, peg)).toBeCloseTo(1);
    expect(usdToTokens(1, peg)).toBeCloseTo(1_000_000);
    expect(usdToTokens(tokensToUsd(123_456, peg), peg)).toBeCloseTo(123_456);
  });

  it("converts tokens to chips", () => {
    expect(tokensToChips(200_000, peg)).toBe(200);
  });

  it("formats token amounts", () => {
    expect(formatTokens(1_500_000)).toBe("1.50M");
    expect(formatTokens(25_000)).toBe("25.0k");
    expect(formatTokens(-25_000)).toBe("-25.0k");
    expect(formatTokens(999)).toBe("999");
  });
});

describe("freezePeg", () => {
  const fakeClient = (pricing: Map<string, { promptUsdPerToken: number; completionUsdPerToken: number }>) =>
    ({ modelPricing: async () => pricing }) as unknown as OpenRouterClient;

  it("freezes the reference model's output price", async () => {
    const frozen = await freezePeg(
      fakeClient(new Map([["ref/model", { promptUsdPerToken: 1e-7, completionUsdPerToken: 9.5e-7 }]])),
      "ref/model",
      1_000,
    );
    expect(frozen.usdPerToken).toBeCloseTo(9.5e-7);
    expect(frozen.tokensPerChip).toBe(1_000);
  });

  it("rejects unknown or free models", async () => {
    await expect(freezePeg(fakeClient(new Map()), "missing/model", 1_000)).rejects.toThrow(
      "not found",
    );
    await expect(
      freezePeg(
        fakeClient(new Map([["free/model", { promptUsdPerToken: 0, completionUsdPerToken: 0 }]])),
        "free/model",
        1_000,
      ),
    ).rejects.toThrow("positive");
  });
});
