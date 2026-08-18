import type { OpenRouterClient } from "./openrouter.ts";

/**
 * The peg: chips are tokens on the felt, USD in the ledger.
 * 1 chip = tokensPerChip tokens of the reference model, valued at that model's
 * output-token price, frozen when the table opens.
 */
export interface Peg {
  readonly referenceModel: string;
  readonly tokensPerChip: number;
  readonly usdPerToken: number;
  readonly frozenAt: string;
}

export async function freezePeg(
  client: OpenRouterClient,
  referenceModel: string,
  tokensPerChip: number,
): Promise<Peg> {
  const pricing = await client.modelPricing();
  const model = pricing.get(referenceModel);
  if (!model) {
    throw new Error(`reference model not found on OpenRouter: ${referenceModel}`);
  }
  if (!(model.completionUsdPerToken > 0)) {
    throw new Error(
      `reference model has no positive output-token price (${referenceModel}); pick a paid model`,
    );
  }
  return {
    referenceModel,
    tokensPerChip,
    usdPerToken: model.completionUsdPerToken,
    frozenAt: new Date().toISOString(),
  };
}

export const tokensToUsd = (tokens: number, peg: Peg): number => tokens * peg.usdPerToken;

export const usdToTokens = (usd: number, peg: Peg): number => usd / peg.usdPerToken;

export const tokensToChips = (tokens: number, peg: Peg): number => tokens / peg.tokensPerChip;

export function formatTokens(tokens: number): string {
  const sign = tokens < 0 ? "-" : "";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString("en-US")}`;
}
