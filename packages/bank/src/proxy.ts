import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ClaimsStore } from "./claims.ts";
import type { Vault } from "./vault.ts";

/**
 * Localhost redemption proxy: winners point their own LLM tooling at this
 * endpoint with a claim token; the proxy forwards to OpenRouter using the
 * debtor's staked key and meters the spend against the claim.
 */

const UPSTREAM_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface RedemptionProxyOptions {
  /** Pass 0 to bind an ephemeral port; the actual port is in the returned handle. */
  readonly port: number;
  readonly vault: Vault;
  readonly claims: ClaimsStore;
  /** Bearer claim token → claim id. */
  readonly claimTokens: ReadonlyMap<string, string>;
  readonly fetchImpl?: typeof fetch;
}

export interface RedemptionProxyHandle {
  readonly port: number;
  close(): Promise<void>;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

export async function startRedemptionProxy(
  opts: RedemptionProxyOptions,
): Promise<RedemptionProxyHandle> {
  /**
   * Promise-chain mutex per debtor: concurrent claims against one staked key
   * must not interleave upstream calls (spend accounting and key rate limits).
   */
  const debtorTails = new Map<string, Promise<void>>();
  const withDebtorLock = <T>(debtor: string, fn: () => Promise<T>): Promise<T> => {
    const tail = debtorTails.get(debtor) ?? Promise.resolve();
    const next = tail.then(fn);
    debtorTails.set(
      debtor,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  async function handleRedemption(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    const claimId = token === null ? undefined : opts.claimTokens.get(token);
    if (claimId === undefined) {
      return sendJson(res, 403, { error: "unknown claim token" });
    }
    const claim = opts.claims.get(claimId);
    if (claim === null) {
      return sendJson(res, 404, { error: `unknown claim: ${claimId}` });
    }
    if (claim.status !== "open") {
      return sendJson(res, 409, { error: `claim ${claimId} is ${claim.status}` });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "request body must be JSON" });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return sendJson(res, 400, { error: "request body must be a JSON object" });
    }
    const body = parsed as Record<string, unknown>;
    if (body.stream === true) {
      return sendJson(res, 400, { error: "streaming not supported; non-streaming only" });
    }

    await withDebtorLock(claim.from, async () => {
      // Re-check inside the lock: a queued redemption may have closed the claim.
      const current = opts.claims.get(claimId);
      if (current === null || current.status !== "open") {
        return sendJson(res, 409, { error: `claim ${claimId} is ${current?.status ?? "missing"}` });
      }
      const apiKey = opts.vault.getKey(current.from);
      if (apiKey === null) {
        return sendJson(res, 500, { error: `no staked key in vault for ${current.from}` });
      }

      const fetchImpl = opts.fetchImpl ?? fetch;
      const upstream = await fetchImpl(UPSTREAM_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: body.model,
          messages: body.messages,
          ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        }),
      });

      if (upstream.status === 401 || upstream.status === 402 || upstream.status === 403) {
        const reason = `staked key revoked or exhausted (${upstream.status})`;
        opts.claims.markDefaulted(claimId, reason);
        return sendJson(res, 502, { error: reason });
      }
      if (!upstream.ok) {
        return sendJson(res, 502, { error: `upstream error (${upstream.status})` });
      }

      const text = await upstream.text();
      let upstreamBody: { id?: unknown; usage?: { cost?: unknown } } = {};
      try {
        upstreamBody = JSON.parse(text) as typeof upstreamBody;
      } catch {
        // Unparseable success body: fall through to the conservative estimate.
      }
      const cost = typeof upstreamBody.usage?.cost === "number" ? upstreamBody.usage.cost : null;
      const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
      const usd = cost ?? (maxTokens ?? 1000) * 2e-6;
      const generationId = typeof upstreamBody.id === "string" ? upstreamBody.id : undefined;
      if (generationId !== undefined) opts.claims.redeem(claimId, usd, generationId);
      else opts.claims.redeem(claimId, usd);

      const after = opts.claims.get(claimId);
      const remainingUsd = after === null ? 0 : Math.max(0, after.usdCap - after.usdRedeemed);
      sendJson(res, upstream.status, text, {
        "x-tablestakes-claim-id": claimId,
        "x-tablestakes-claim-remaining-usd": remainingUsd.toString(),
        ...(cost === null ? { "x-tablestakes-estimated": "1" } : {}),
      });
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/claims") {
      return sendJson(res, 200, opts.claims.all());
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleRedemption(req, res);
    }
    return sendJson(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("redemption proxy failed to bind a TCP port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
