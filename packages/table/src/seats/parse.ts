import type { LegalAction, PlayerAction } from "@table-stakes/engine";
import { fallbackAction, sanitizeEmoji, type Reaction } from "./driver.ts";

/**
 * Shared reply parsing for every LLM-backed seat (model, ACP, MCP): free-form
 * text in, one validated poker action out.
 */

/**
 * Extract every top-level {...} block that parses as JSON from free-form model
 * output. Resilient to unmatched braces in prose: each candidate "{" is scanned
 * independently, so a stray brace earlier in the reply can't hide a valid
 * action object later.
 */
export function extractJsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      i += 1;
      continue;
    }
    try {
      found.push(JSON.parse(text.slice(i, end + 1)));
      i = end + 1;
    } catch {
      i += 1;
    }
  }
  return found;
}

export interface ParsedReply {
  readonly kind: string;
  readonly amount?: number;
  readonly say?: string;
  readonly react?: Reaction;
}

function coerceAmount(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[,_\s]/g, "");
    if (cleaned !== "" && Number.isFinite(Number(cleaned))) return Math.round(Number(cleaned));
  }
  return undefined;
}

function parseReact(raw: unknown): Reaction | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.emoji !== "string") return undefined;
  const emoji = sanitizeEmoji(rec.emoji);
  if (!emoji) return undefined;
  const target = coerceAmount(rec.to);
  return { emoji, ...(target !== undefined ? { targetSeq: target } : {}) };
}

export function parseReply(content: string): ParsedReply | null {
  const objects = extractJsonObjects(content);
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.action !== "string") continue;
    const kind = rec.action.toLowerCase().trim();
    const amount = coerceAmount(rec.amount);
    const say = typeof rec.say === "string" ? rec.say : undefined;
    const react = parseReact(rec.react);
    return {
      kind,
      ...(amount !== undefined ? { amount } : {}),
      ...(say !== undefined ? { say } : {}),
      ...(react !== undefined ? { react } : {}),
    };
  }
  return null;
}

/** Parse a pure banter reply: {"say": "...", "react": {...}} — no action. */
export function parseBanter(content: string): { say?: string; react?: Reaction } | null {
  const objects = extractJsonObjects(content);
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const say = typeof rec.say === "string" ? rec.say : undefined;
    const react = parseReact(rec.react);
    if (say === undefined && react === undefined) continue;
    return {
      ...(say !== undefined ? { say } : {}),
      ...(react !== undefined ? { react } : {}),
    };
  }
  return null;
}

/**
 * Map a model's requested action onto a legal engine action.
 * A "raise" at or below the call amount is a call (the model wasn't raising);
 * amounts between call and min-raise clamp up (genuine raise intent);
 * unusable requests fall back to check-or-fold.
 */
export function resolveAction(
  parsed: ParsedReply,
  legal: readonly LegalAction[],
): { action: PlayerAction; adjusted?: string; fallback?: string } {
  const has = (kind: string) => legal.some((a) => a.kind === kind);
  const range = legal.find((a) => a.kind === "bet-to" || a.kind === "raise-to");
  const call = legal.find((a) => a.kind === "call");

  const clampTo = (requested: number): { action: PlayerAction; adjusted?: string } => {
    if (!range || (range.kind !== "bet-to" && range.kind !== "raise-to")) {
      throw new Error("no bet/raise available");
    }
    const amount = Math.min(Math.max(requested, range.minAmount), range.maxAmount);
    return {
      action: { kind: range.kind, amount },
      ...(amount !== requested
        ? { adjusted: `requested ${requested}, clamped to ${amount}` }
        : {}),
    };
  };

  switch (parsed.kind) {
    case "fold":
      // Folding when checking is free is legal but strictly dominated; never
      // what a model means. Take the free check instead.
      if (has("check")) {
        return { action: { kind: "check" }, adjusted: "fold requested, check was free" };
      }
      if (has("fold")) return { action: { kind: "fold" } };
      break;
    case "check":
      if (has("check")) return { action: { kind: "check" } };
      break;
    case "call":
      if (has("call")) return { action: { kind: "call" } };
      if (has("check")) return { action: { kind: "check" }, adjusted: "call requested, nothing to call" };
      break;
    case "bet":
    case "bet-to":
    case "raise":
    case "raise-to": {
      if (range && parsed.amount !== undefined) {
        if (call && call.kind === "call" && parsed.amount <= call.amount) {
          return {
            action: { kind: "call" },
            adjusted: `requested ${parsed.kind} to ${parsed.amount} is not above the call (${call.amount}); called`,
          };
        }
        return clampTo(parsed.amount);
      }
      if (has("call")) {
        return { action: { kind: "call" }, adjusted: `${parsed.kind} without a usable amount, called instead` };
      }
      break;
    }
    case "all-in":
    case "allin":
    case "shove": {
      if (range && (range.kind === "bet-to" || range.kind === "raise-to")) {
        return { action: { kind: range.kind, amount: range.maxAmount } };
      }
      if (has("call")) return { action: { kind: "call" }, adjusted: "shove unavailable, called" };
      break;
    }
    default:
      break;
  }
  return {
    action: fallbackAction(legal),
    fallback: `unusable action "${parsed.kind}"`,
  };
}
