import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { tokensToUsd, type Peg } from "./pricing.ts";

/**
 * Winner claims against staked keys: each settlement pair becomes a claim
 * capped at the pegged USD value of the tokens owed. Redemptions are metered
 * inference spend routed through the debtor's staked key.
 */
export interface Claim {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly tokens: number;
  readonly usdCap: number;
  readonly usdRedeemed: number;
  readonly status: "open" | "exhausted" | "defaulted";
}

export type ClaimOp =
  | { readonly op: "claim_created"; readonly claim: Claim }
  | {
      readonly op: "claim_redeemed";
      readonly claimId: string;
      readonly usd: number;
      readonly generationId?: string;
    }
  | { readonly op: "claim_defaulted"; readonly claimId: string; readonly reason: string };

/** Float drift tolerance when deciding a claim is fully redeemed. */
const EXHAUSTION_EPSILON = 1e-9;

export function buildClaims(
  pairs: ReadonlyArray<{ from: string; to: string; tokens: number }>,
  peg: Peg,
): Claim[] {
  return pairs.map((pair, index) => ({
    id: `claim-${index + 1}-${pair.from}-${pair.to}`,
    from: pair.from,
    to: pair.to,
    tokens: pair.tokens,
    usdCap: tokensToUsd(pair.tokens, peg),
    usdRedeemed: 0,
    status: "open" as const,
  }));
}

/** Append-only JSONL store (like the ledger); state is folded from the op log on read. */
export class ClaimsStore {
  private readonly ops: ClaimOp[] = [];

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (line.trim() !== "") this.ops.push(JSON.parse(line) as ClaimOp);
      }
    }
  }

  create(claims: Claim[]): void {
    for (const claim of claims) this.append({ op: "claim_created", claim });
  }

  redeem(claimId: string, usd: number, generationId?: string): void {
    this.append({
      op: "claim_redeemed",
      claimId,
      usd,
      ...(generationId !== undefined ? { generationId } : {}),
    });
  }

  markDefaulted(claimId: string, reason: string): void {
    this.append({ op: "claim_defaulted", claimId, reason });
  }

  /** Claims in creation order with redemptions summed; defaulted is sticky. */
  all(): Claim[] {
    const order: string[] = [];
    const states = new Map<string, { claim: Claim; usdRedeemed: number; defaulted: boolean }>();
    for (const op of this.ops) {
      if (op.op === "claim_created") {
        if (!states.has(op.claim.id)) order.push(op.claim.id);
        states.set(op.claim.id, {
          claim: op.claim,
          usdRedeemed: op.claim.usdRedeemed,
          defaulted: op.claim.status === "defaulted",
        });
      } else {
        const state = states.get(op.claimId);
        if (!state) continue;
        if (op.op === "claim_redeemed") state.usdRedeemed += op.usd;
        else state.defaulted = true;
      }
    }
    return order.map((id) => {
      const state = states.get(id);
      if (!state) throw new Error(`unreachable: no folded state for claim ${id}`);
      const status: Claim["status"] = state.defaulted
        ? "defaulted"
        : state.usdRedeemed >= state.claim.usdCap - EXHAUSTION_EPSILON
          ? "exhausted"
          : "open";
      return { ...state.claim, usdRedeemed: state.usdRedeemed, status };
    });
  }

  get(claimId: string): Claim | null {
    return this.all().find((claim) => claim.id === claimId) ?? null;
  }

  private append(op: ClaimOp): void {
    appendFileSync(this.filePath, `${JSON.stringify(op)}\n`, "utf8");
    this.ops.push(op);
  }
}
