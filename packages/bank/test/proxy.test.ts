import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaims, ClaimsStore } from "../src/claims.ts";
import type { Peg } from "../src/pricing.ts";
import { startRedemptionProxy } from "../src/proxy.ts";
import { Vault } from "../src/vault.ts";

const peg: Peg = {
  referenceModel: "test/model",
  tokensPerChip: 1_000,
  usdPerToken: 0.000001,
  frozenAt: "2026-08-18T00:00:00.000Z",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface TestTable {
  readonly claims: ClaimsStore;
  readonly base: string;
  readonly close: () => Promise<void>;
}

async function startTable(opts: {
  pairs: ReadonlyArray<{ from: string; to: string; tokens: number }>;
  claimTokens: ReadonlyArray<readonly [string, string]>;
  stakedKeys: ReadonlyArray<readonly [string, string]>;
  fetchImpl: typeof fetch;
}): Promise<TestTable> {
  const dir = mkdtempSync(join(tmpdir(), "proxy-"));
  const vault = Vault.open(join(dir, "vault.json"), "table passphrase");
  for (const [playerId, apiKey] of opts.stakedKeys) vault.addKey(playerId, apiKey);
  const claims = new ClaimsStore(join(dir, "claims.jsonl"));
  claims.create(buildClaims(opts.pairs, peg));
  const proxy = await startRedemptionProxy({
    port: 0,
    vault,
    claims,
    claimTokens: new Map<string, string>(opts.claimTokens),
    fetchImpl: opts.fetchImpl,
  });
  return { claims, base: `http://127.0.0.1:${proxy.port}`, close: proxy.close };
}

const chat = (base: string, token: string, body: unknown) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const singleClaimTable = (fetchImpl: typeof fetch) =>
  startTable({
    pairs: [{ from: "debtor", to: "winner", tokens: 50_000 }],
    claimTokens: [["tok-winner", "claim-1-debtor-winner"]],
    stakedKeys: [["debtor", "sk-or-staked"]],
    fetchImpl,
  });

describe("startRedemptionProxy", () => {
  it("redeems a claim through the debtor's staked key", async () => {
    const upstreamCalls: Array<{
      url: string;
      auth: string | null;
      body: Record<string, unknown>;
    }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      upstreamCalls.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({
        id: "gen-1",
        choices: [{ message: { content: "hi" } }],
        usage: { cost: 0.01 },
      });
    };
    const table = await singleClaimTable(fetchImpl);
    try {
      const res = await chat(table.base, "tok-winner", {
        model: "test/model",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
        metadata: { dropped: true },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-tablestakes-claim-id")).toBe("claim-1-debtor-winner");
      expect(Number(res.headers.get("x-tablestakes-claim-remaining-usd"))).toBeCloseTo(0.04);
      expect(res.headers.get("x-tablestakes-estimated")).toBeNull();
      const body = (await res.json()) as { id?: string };
      expect(body.id).toBe("gen-1");

      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(upstreamCalls[0]?.auth).toBe("Bearer sk-or-staked");
      // Only the allowed fields are forwarded; extras like metadata are dropped.
      expect(Object.keys(upstreamCalls[0]?.body ?? {}).sort()).toEqual([
        "max_tokens",
        "messages",
        "model",
      ]);

      const claim = table.claims.get("claim-1-debtor-winner");
      expect(claim?.usdRedeemed).toBeCloseTo(0.01);
      expect(claim?.status).toBe("open");
    } finally {
      await table.close();
    }
  });

  it("serializes concurrent redemptions against one debtor's key", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      calls += 1;
      return jsonResponse({ id: `gen-${calls}`, usage: { cost: 0.001 } });
    };
    const table = await startTable({
      pairs: [
        { from: "debtor", to: "b", tokens: 10_000 },
        { from: "debtor", to: "c", tokens: 10_000 },
      ],
      claimTokens: [
        ["tok-b", "claim-1-debtor-b"],
        ["tok-c", "claim-2-debtor-c"],
      ],
      stakedKeys: [["debtor", "sk-or-staked"]],
      fetchImpl,
    });
    try {
      const [res1, res2] = await Promise.all([
        chat(table.base, "tok-b", { model: "m", messages: [] }),
        chat(table.base, "tok-c", { model: "m", messages: [] }),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      await Promise.all([res1.text(), res2.text()]);
      expect(calls).toBe(2);
      expect(maxInFlight).toBe(1);
      expect(table.claims.get("claim-1-debtor-b")?.usdRedeemed).toBeCloseTo(0.001);
      expect(table.claims.get("claim-2-debtor-c")?.usdRedeemed).toBeCloseTo(0.001);
    } finally {
      await table.close();
    }
  });

  it("defaults the claim when the staked key is dead upstream", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: "insufficient credits" }, 402);
    const table = await singleClaimTable(fetchImpl);
    try {
      const res = await chat(table.base, "tok-winner", { model: "m", messages: [] });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("staked key revoked or exhausted (402)");
      expect(table.claims.get("claim-1-debtor-winner")?.status).toBe("defaulted");

      const retry = await chat(table.base, "tok-winner", { model: "m", messages: [] });
      expect(retry.status).toBe(409);
    } finally {
      await table.close();
    }
  });

  it("rejects streaming requests", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({});
    const table = await singleClaimTable(fetchImpl);
    try {
      const res = await chat(table.base, "tok-winner", {
        model: "m",
        messages: [],
        stream: true,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("streaming not supported; non-streaming only");
      expect(table.claims.get("claim-1-debtor-winner")?.usdRedeemed).toBe(0);
    } finally {
      await table.close();
    }
  });

  it("rejects unknown claim tokens", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({});
    const table = await singleClaimTable(fetchImpl);
    try {
      const res = await chat(table.base, "tok-mallory", { model: "m", messages: [] });
      expect(res.status).toBe(403);
    } finally {
      await table.close();
    }
  });

  it("redeems a conservative estimate when upstream omits cost", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ id: "gen-est", choices: [{ message: { content: "hi" } }] });
    const table = await singleClaimTable(fetchImpl);
    try {
      const res = await chat(table.base, "tok-winner", {
        model: "m",
        messages: [],
        max_tokens: 500,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-tablestakes-estimated")).toBe("1");
      expect(table.claims.get("claim-1-debtor-winner")?.usdRedeemed).toBeCloseTo(0.001);
    } finally {
      await table.close();
    }
  });

  it("lists claims without key material and 404s elsewhere", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({});
    const table = await singleClaimTable(fetchImpl);
    try {
      const res = await fetch(`${table.base}/claims`);
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ id: string; status: string }>;
      expect(list.map((claim) => claim.id)).toEqual(["claim-1-debtor-winner"]);
      expect(JSON.stringify(list)).not.toContain("sk-or-staked");

      const missing = await fetch(`${table.base}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await table.close();
    }
  });
});
