import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  cardToString,
  createDeck,
  type Card,
  type DomainEvent,
} from "@hivetech/poker-engine";

/**
 * Commit–reveal dealing.
 *
 * Before a hand: the server draws `serverSeed`, publishes SHA-256(serverSeed).
 * Each seat contributes a client seed. The deck is a Fisher–Yates shuffle driven
 * by an HMAC-SHA256 counter stream keyed on the server seed over the client
 * seeds + hand nonce. After the hand the server reveals the seed; anyone can
 * recompute the exact deck.
 *
 * Scope (stated in the proposal): proves the deck was fixed before the hand and
 * untampered mid-hand. It does not prevent the host from peeking — trusted dealer.
 */

export interface DealInput {
  /** Hex server seed (secret until reveal). */
  readonly serverSeed: string;
  /** Client seeds in seat order — order is part of the derivation. */
  readonly clientSeeds: readonly string[];
  /** Hand number; makes each hand's stream distinct under a reused seed. */
  readonly nonce: number;
}

export function newServerSeed(): string {
  return randomBytes(32).toString("hex");
}

export function newClientSeed(): string {
  return randomBytes(8).toString("hex");
}

export function commitment(serverSeed: string): string {
  return createHash("sha256").update(serverSeed, "utf8").digest("hex");
}

/** Deterministic byte stream: HMAC-SHA256(serverSeed, `${material}:${counter}`). */
class HmacDrbg {
  private block: Buffer = Buffer.alloc(0);
  private offset = 0;
  private counter = 0;

  constructor(
    private readonly key: string,
    private readonly material: string,
  ) {}

  private nextByte(): number {
    if (this.offset >= this.block.length) {
      this.block = createHmac("sha256", this.key)
        .update(`${this.material}:${this.counter}`)
        .digest();

      this.counter += 1;
      this.offset = 0;
    }
    const byte = this.block[this.offset];
    this.offset += 1;
    return byte as number;
  }

  /** Unbiased integer in [0, maxExclusive) via rejection sampling on 32-bit draws. */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
      throw new RangeError(`nextInt bound out of range: ${maxExclusive}`);
    }
    const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
    for (;;) {
      let value = 0;
      for (let i = 0; i < 4; i += 1) {
        value = value * 256 + this.nextByte();
      }
      if (value < limit) return value % maxExclusive;
    }
  }
}

export function deriveDeck(input: DealInput): Card[] {
  const material = `${input.clientSeeds.join(",")}:${input.nonce}`;
  const drbg = new HmacDrbg(input.serverSeed, material);
  const deck = createDeck();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = drbg.nextInt(i + 1);
    const a = deck[i] as Card;
    deck[i] = deck[j] as Card;
    deck[j] = a;
  }
  return deck;
}

export interface DealVerification {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * Verify that the cards actually dealt in a hand came from the given deck in
 * the engine's deal order: two round-robin hole-card rounds (in hole-cards-dealt
 * event order), then one burn before each street. Without this check, comparing
 * a recorded deck against a re-derived one is circular — it never proves the
 * ENGINE was fed that deck.
 */
export function verifyHandDealing(
  deckCodes: readonly string[],
  events: readonly DomainEvent[],
): DealVerification {
  const reasons: string[] = [];
  const holeEvents = events.filter((e) => e.type === "hole-cards-dealt");
  const playerCount = holeEvents.length;
  if (playerCount < 2) {
    return { ok: false, reasons: ["fewer than two hole-cards-dealt events"] };
  }

  holeEvents.forEach((event, i) => {
    if (event.type !== "hole-cards-dealt") return;
    const expected = [deckCodes[i], deckCodes[playerCount + i]];
    const actual = event.cards.map(cardToString);
    if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
      reasons.push(
        `hole cards for ${event.playerId} are ${actual.join(",")}, expected ${expected.join(",")} from deck`,
      );
    }
  });

  let next = playerCount * 2;
  for (const event of events) {
    if (event.type !== "street-dealt") continue;
    next += 1; // burn card
    const expected = deckCodes.slice(next, next + event.cards.length);
    const actual = event.cards.map(cardToString);
    if (actual.join(",") !== expected.join(",")) {
      reasons.push(
        `${event.street} is ${actual.join(",")}, expected ${expected.join(",")} from deck`,
      );
    }
    next += event.cards.length;
  }

  return { ok: reasons.length === 0, reasons };
}

/** Recompute the deck from revealed material and check it against the record. */
export function verifyDeal(args: {
  readonly commit: string;
  readonly serverSeed: string;
  readonly clientSeeds: readonly string[];
  readonly nonce: number;
  readonly deckCodes: readonly string[];
}): DealVerification {
  const reasons: string[] = [];
  if (commitment(args.serverSeed) !== args.commit) {
    reasons.push("server seed does not match the pre-hand commitment");
  }
  const derived = deriveDeck({
    serverSeed: args.serverSeed,
    clientSeeds: args.clientSeeds,
    nonce: args.nonce,
  }).map(cardToString);
  if (
    derived.length !== args.deckCodes.length ||
    derived.some((code, i) => code !== args.deckCodes[i])
  ) {
    reasons.push("derived deck does not match the recorded deck");
  }
  return { ok: reasons.length === 0, reasons };
}
