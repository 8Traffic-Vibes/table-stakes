const BASE = "https://openrouter.ai/api/v1";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export interface KeyInfo {
  readonly label: string;
  readonly limitUsd: number | null;
  readonly limitRemainingUsd: number | null;
  readonly limitReset: string | null;
  readonly usageUsd: number;
  readonly isFreeTier: boolean;
  /** Nonzero means BYOK is in play — stake caps on this key are fiction. */
  readonly byokUsageUsd: number;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface ChatUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly upstreamCostUsd: number | null;
}

export interface ChatResult {
  readonly content: string;
  readonly usage: ChatUsage;
  readonly generationId: string | null;
  readonly model: string;
  readonly finishReason: string | null;
}

export interface ModelPricing {
  readonly promptUsdPerToken: number;
  readonly completionUsdPerToken: number;
}

export interface GenerationAudit {
  readonly totalCostUsd: number;
  readonly nativePromptTokens: number;
  readonly nativeCompletionTokens: number;
  readonly cacheDiscount: number | null;
  readonly upstreamCostUsd: number | null;
}

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly attribution: { readonly title?: string; readonly referer?: string } = {},
  ) {}

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (json) headers["Content-Type"] = "application/json";
    if (this.attribution.title) headers["X-Title"] = this.attribution.title;
    if (this.attribution.referer) headers["HTTP-Referer"] = this.attribution.referer;
    return headers;
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      headers: this.headers(false),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new OpenRouterError(`GET ${path} failed (${res.status})`, res.status, text);
    }
    return JSON.parse(text) as unknown;
  }

  async keyInfo(): Promise<KeyInfo> {
    const body = (await this.get("/key")) as { data: Record<string, unknown> };
    const d = body.data;
    return {
      label: String(d.label ?? ""),
      limitUsd: d.limit === null || d.limit === undefined ? null : Number(d.limit),
      limitRemainingUsd:
        d.limit_remaining === null || d.limit_remaining === undefined
          ? null
          : Number(d.limit_remaining),
      limitReset: d.limit_reset === null || d.limit_reset === undefined ? null : String(d.limit_reset),
      usageUsd: Number(d.usage ?? 0),
      isFreeTier: Boolean(d.is_free_tier),
      byokUsageUsd: Number(d.byok_usage ?? 0),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        }),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw error;
      }
      // undici wraps network failures in a generic "fetch failed" — surface the
      // cause and mark it retryable (status 599) so one blip isn't a fold.
      const cause =
        error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
      throw new OpenRouterError(
        `network error: ${error instanceof Error ? error.message : String(error)}${cause}`,
        599,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new OpenRouterError(`chat/completions failed (${res.status})`, res.status, text);
    }
    const body = JSON.parse(text) as {
      id?: string;
      model?: string;
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
        cost_details?: { upstream_inference_cost?: number | null };
      };
    };
    const choice = body.choices?.[0];
    const usage = body.usage;
    return {
      content: choice?.message?.content ?? "",
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        costUsd: usage?.cost ?? 0,
        upstreamCostUsd: usage?.cost_details?.upstream_inference_cost ?? null,
      },
      generationId: body.id ?? null,
      model: body.model ?? req.model,
      finishReason: choice?.finish_reason ?? null,
    };
  }

  /** Per-model USD-per-token pricing, the conversion table for the peg. */
  async modelPricing(): Promise<Map<string, ModelPricing>> {
    const body = (await this.get("/models")) as {
      data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    const map = new Map<string, ModelPricing>();
    for (const model of body.data) {
      map.set(model.id, {
        promptUsdPerToken: Number(model.pricing?.prompt ?? 0),
        completionUsdPerToken: Number(model.pricing?.completion ?? 0),
      });
    }
    return map;
  }

  /** Authoritative post-hoc settlement record for one generation. Null if not (yet) available. */
  async generation(id: string): Promise<GenerationAudit | null> {
    try {
      const body = (await this.get(`/generation?id=${encodeURIComponent(id)}`)) as {
        data: Record<string, unknown>;
      };
      const d = body.data;
      return {
        totalCostUsd: Number(d.total_cost ?? 0),
        nativePromptTokens: Number(d.native_tokens_prompt ?? 0),
        nativeCompletionTokens: Number(d.native_tokens_completion ?? 0),
        cacheDiscount: d.cache_discount === null || d.cache_discount === undefined ? null : Number(d.cache_discount),
        upstreamCostUsd:
          d.upstream_inference_cost === null || d.upstream_inference_cost === undefined
            ? null
            : Number(d.upstream_inference_cost),
      };
    } catch (error) {
      if (error instanceof OpenRouterError && error.status === 404) return null;
      throw error;
    }
  }
}
