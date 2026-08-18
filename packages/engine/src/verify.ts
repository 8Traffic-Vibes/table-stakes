import { readFileSync } from "node:fs";
import type { DomainEvent } from "@hivetech/poker-engine";
import { verifyDeal, verifyHandDealing } from "./dealing.ts";

/**
 * Offline fairness/audit verifier for a session's events.jsonl.
 *
 * Takes the parsed log lines as untrusted data (a tampered log must produce
 * failed checks, never a crash) and re-checks, per committed hand:
 *  - commitOk: the revealed server seed matches the pre-hand commitment and
 *    re-derives the recorded deck (commit–reveal, see ./dealing.ts);
 *  - dealOk: the cards the engine actually dealt came from that deck in deal
 *    order (the non-circular check);
 *  - conservationOk: the hand settlement's token deltas sum to zero.
 * Plus global checks: seq strictly increasing, and no orphaned commitments
 * (a deck_committed whose seed was never revealed is unverifiable).
 */

export interface HandVerification {
  readonly handNo: number;
  readonly ok: boolean;
  readonly commitOk: boolean;
  readonly dealOk: boolean;
  readonly conservationOk: boolean;
  readonly reasons: string[];
}

export interface RunVerification {
  readonly ok: boolean;
  readonly handsChecked: number;
  readonly hands: HandVerification[];
  readonly reasons: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/** Client seeds in recorded order — the order is part of the deck derivation. */
function readClientSeeds(seedsEvent: Record<string, unknown> | null): string[] | null {
  if (!seedsEvent) return null;
  const seeds = seedsEvent["seeds"];
  if (!Array.isArray(seeds)) return null;
  const out: string[] = [];
  for (const entry of seeds) {
    if (!isRecord(entry)) return null;
    const seed = asString(entry["seed"]);
    if (seed === null) return null;
    out.push(seed);
  }
  return out;
}

function findHandEvent(
  events: ReadonlyArray<Record<string, unknown>>,
  type: string,
  handNo: number,
): Record<string, unknown> | null {
  for (const event of events) {
    if (event["type"] === type && asNumber(event["handNo"]) === handNo) return event;
  }
  return null;
}

/** Raw engine events for one hand, in log order, cast to the engine's type. */
function collectEngineEvents(
  events: ReadonlyArray<Record<string, unknown>>,
  handNo: number,
): readonly DomainEvent[] {
  const out: unknown[] = [];
  for (const event of events) {
    if (
      event["type"] === "engine_event" &&
      asNumber(event["handNo"]) === handNo &&
      isRecord(event["event"])
    ) {
      out.push(event["event"]);
    }
  }
  return out as DomainEvent[];
}

function verifyHand(
  handNo: number,
  events: ReadonlyArray<Record<string, unknown>>,
): HandVerification {
  const reasons: string[] = [];

  const committed = findHandEvent(events, "deck_committed", handNo);
  const seedsEvent = findHandEvent(events, "seeds_collected", handNo);
  const revealEvent = findHandEvent(events, "seed_revealed", handNo);

  const commit = committed ? asString(committed["commit"]) : null;
  const clientSeeds = readClientSeeds(seedsEvent);
  const serverSeed = revealEvent ? asString(revealEvent["serverSeed"]) : null;
  const deckCodes = revealEvent ? readStringArray(revealEvent["deckCodes"]) : null;

  if (!revealEvent) {
    reasons.push("orphaned commitment: deck_committed without seed_revealed");
  } else if (serverSeed === null || deckCodes === null) {
    reasons.push("seed_revealed is malformed (missing serverSeed or deckCodes)");
  }
  if (commit === null) reasons.push("deck_committed has no commit hash");
  if (seedsEvent === null) {
    reasons.push("no seeds_collected event for this hand");
  } else if (clientSeeds === null) {
    reasons.push("seeds_collected is malformed");
  }

  let commitOk = false;
  if (commit !== null && clientSeeds !== null && serverSeed !== null && deckCodes !== null) {
    const deal = verifyDeal({ commit, serverSeed, clientSeeds, nonce: handNo, deckCodes });
    commitOk = deal.ok;
    reasons.push(...deal.reasons);
  }

  const engineEvents = collectEngineEvents(events, handNo);
  let dealOk = false;
  if (deckCodes !== null) {
    const dealing = verifyHandDealing(deckCodes, engineEvents);
    dealOk = dealing.ok;
    reasons.push(...dealing.reasons);
  }

  const settled = findHandEvent(events, "hand_settled", handNo);
  const completed = engineEvents.some((event) => event.type === "hand-completed");
  let conservationOk = false;
  if (settled) {
    const deltas = settled["deltasTokens"];
    if (!isRecord(deltas)) {
      reasons.push("hand_settled has no deltasTokens record");
    } else {
      const values = Object.values(deltas);
      if (values.some((v) => asNumber(v) === null)) {
        reasons.push("hand_settled deltasTokens has non-numeric entries");
      } else {
        const sum = values.reduce<number>((acc, v) => acc + (v as number), 0);
        if (sum === 0) conservationOk = true;
        else reasons.push(`hand_settled deltasTokens sum to ${sum}, expected 0`);
      }
    }
  } else if (completed) {
    reasons.push("hand completed but never settled (no hand_settled event)");
  } else {
    // Never completed, never settled: nothing to conserve.
    conservationOk = true;
  }

  const ok = commitOk && dealOk && conservationOk;
  return { handNo, ok, commitOk, dealOk, conservationOk, reasons };
}

/** Verify a full run from its parsed JSONL lines (LoggedEvent-shaped, untrusted). */
export function verifyRunEvents(
  events: ReadonlyArray<Record<string, unknown>>,
): RunVerification {
  const reasons: string[] = [];

  let prevSeq: number | null = null;
  for (const [index, event] of events.entries()) {
    const seq = asNumber(event["seq"]);
    if (seq === null) {
      reasons.push(`event at index ${index} has no numeric seq`);
      continue;
    }
    if (prevSeq !== null && seq <= prevSeq) {
      reasons.push(`seq not strictly increasing at index ${index} (${seq} after ${prevSeq})`);
    }
    prevSeq = seq;
  }

  const handNos: number[] = [];
  for (const event of events) {
    if (event["type"] !== "deck_committed") continue;
    const handNo = asNumber(event["handNo"]);
    if (handNo !== null && !handNos.includes(handNo)) handNos.push(handNo);
  }
  handNos.sort((a, b) => a - b);

  for (const handNo of handNos) {
    if (!findHandEvent(events, "seed_revealed", handNo)) {
      reasons.push(`hand ${handNo}: orphaned commitment (deck_committed without seed_revealed)`);
    }
  }

  const hands = handNos.map((handNo) => verifyHand(handNo, events));
  const ok = hands.every((hand) => hand.ok) && reasons.length === 0;
  return { ok, handsChecked: hands.length, hands, reasons };
}

/** Read an events.jsonl file (skipping blank lines) and verify the run. */
export function verifyRunFile(eventsJsonlPath: string): RunVerification {
  const parsed: Array<Record<string, unknown>> = [];
  const parseReasons: string[] = [];
  const lines = readFileSync(eventsJsonlPath, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      parseReasons.push(`line ${index + 1} is not valid JSON`);
      continue;
    }
    if (isRecord(value)) parsed.push(value);
    else parseReasons.push(`line ${index + 1} is not a JSON object`);
  }

  const result = verifyRunEvents(parsed);
  if (parseReasons.length === 0) return result;
  return { ...result, ok: false, reasons: [...parseReasons, ...result.reasons] };
}
