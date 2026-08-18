import { randomBytes } from "node:crypto";
import {
  TableRunner,
  commitment,
  deriveDeck,
  newClientSeed,
  newServerSeed,
  cardToString,
  type DomainEvent,
  type LegalAction,
  type PlayerAction,
  type TableCommand,
} from "@table-stakes/engine";
import type {
  ChatLineVM,
  LegalVM,
  ReactionVM,
  SeatVM,
  SettlementVM,
  TableVM,
} from "@/lib/view-model";
import { roomStore } from "./store";

/**
 * Human-mode rooms, shared-state edition: every room is a JSON document in the
 * store; the poker engine is rebuilt deterministically from its command log on
 * each operation (pure engine, cheap replay). No in-process timers — clocks
 * are deadlines in the document, enforced lazily under the room lock by
 * whichever instance notices them. That's what lets any serverless instance
 * serve any request for any room.
 */

const ROOM_CONFIG = {
  smallBlind: 1_000,
  bigBlind: 2_000,
  buyIn: 200_000,
  maxSeats: 6,
  clockMs: 30_000,
  interHandMs: 5_000,
  referenceModel: "deepseek/deepseek-chat-v3.1",
  tokensPerChip: 1_000,
} as const;

const CHAT_MAX_CHARS = 200;
const MAX_ADVANCE_STEPS = 30;

interface HandDoc {
  handNo: number;
  commit: string;
  serverSeed: string;
  seeds: string[];
  street: string;
  revealed: Record<string, string[]>;
  lastAction: Record<string, string>;
}

export interface RoomDoc {
  v: number;
  id: string;
  createdAt: number;
  hostToken: string;
  phase: "waiting" | "playing" | "ended";
  commands: TableCommand[];
  tokens: Record<string, string>;
  names: Record<string, string>;
  buyIns: Record<string, number>;
  chat: ChatLineVM[];
  reactions: ReactionVM[];
  seq: number;
  hand: HandDoc | null;
  actorDeadlineAt: number | null;
  nextHandAt: number | null;
  handCounter: number;
  settlement: SettlementVM | null;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function roomCode(): string {
  const bytes = randomBytes(5);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "player";

function sanitizeName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f<>&"'`]/g, "").trim().slice(0, 24);
}

function sanitizeChat(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_MAX_CHARS);
}

function runnerFrom(doc: RoomDoc): TableRunner {
  const runner = new TableRunner({
    smallBlind: ROOM_CONFIG.smallBlind,
    bigBlind: ROOM_CONFIG.bigBlind,
    minBuyIn: ROOM_CONFIG.buyIn,
    maxBuyIn: ROOM_CONFIG.buyIn * 5,
    maxSeats: ROOM_CONFIG.maxSeats,
  });
  for (const command of doc.commands) runner.dispatch(command);
  return runner;
}

function systemLine(doc: RoomDoc, text: string): void {
  doc.seq += 1;
  doc.chat.push({ seq: doc.seq, from: "table", text, system: true });
  if (doc.chat.length > 120) doc.chat.splice(0, doc.chat.length - 120);
}

/** Apply a command through the runner AND record it in the log. */
function apply(doc: RoomDoc, runner: TableRunner, command: TableCommand): readonly DomainEvent[] {
  const events = runner.dispatch(command);
  doc.commands.push(command);
  return events;
}

function consumeEvents(doc: RoomDoc, events: readonly DomainEvent[]): void {
  const hand = doc.hand;
  for (const event of events) {
    if (!hand) break;
    switch (event.type) {
      case "street-dealt":
        hand.street = event.street;
        break;
      case "cards-revealed":
        hand.revealed[event.playerId] = event.cards.map(cardToString);
        break;
      case "pot-awarded":
        for (const award of event.awards) {
          systemLine(
            doc,
            `${doc.names[award.playerId] ?? award.playerId} wins ${award.amount.toLocaleString()} tokens`,
          );
        }
        break;
      case "hand-completed":
        doc.hand = null;
        doc.actorDeadlineAt = null;
        if (doc.phase === "playing") doc.nextHandAt = Date.now() + ROOM_CONFIG.interHandMs;
        break;
      default:
        break;
    }
  }
}

function actionLabel(action: PlayerAction): string {
  if (action.kind === "bet-to") return `bets ${action.amount.toLocaleString()}`;
  if (action.kind === "raise-to") return `raises to ${action.amount.toLocaleString()}`;
  return action.kind;
}

function refreshClock(doc: RoomDoc, runner: TableRunner): void {
  if (doc.hand && runner.handActive() && runner.currentActorId()) {
    if (doc.actorDeadlineAt === null) doc.actorDeadlineAt = Date.now() + ROOM_CONFIG.clockMs;
  } else if (doc.hand === null) {
    doc.actorDeadlineAt = null;
  }
}

function startHandNow(doc: RoomDoc, runner: TableRunner): void {
  // Sit out busted players first.
  for (const [playerId, stack] of Object.entries(runner.stacks())) {
    const seat = runner.state.seats.find((s) => s?.playerId === playerId);
    if (stack <= 0 && seat?.status === "active") {
      try {
        apply(doc, runner, { type: "set-sitting-out", playerId, sittingOut: true });
      } catch {
        /* between hands; safe to skip */
      }
    }
  }
  const playable = Object.entries(runner.stacks()).filter(([playerId, stack]) => {
    const seat = runner.state.seats.find((s) => s?.playerId === playerId);
    return stack > 0 && seat?.status === "active";
  });
  if (playable.length < 2) {
    doc.nextHandAt = null;
    systemLine(doc, "waiting for at least two stacks — rebuy or invite someone");
    return;
  }

  doc.handCounter += 1;
  const serverSeed = newServerSeed();
  const seeds = playable.map(() => newClientSeed());
  const deck = deriveDeck({ serverSeed, clientSeeds: seeds, nonce: doc.handCounter });
  doc.hand = {
    handNo: doc.handCounter,
    commit: commitment(serverSeed),
    serverSeed,
    seeds,
    street: "preflop",
    revealed: {},
    lastAction: {},
  };
  doc.nextHandAt = null;
  try {
    const events = apply(doc, runner, { type: "start-hand", deck: [...deck] });
    consumeEvents(doc, events);
    doc.actorDeadlineAt = Date.now() + ROOM_CONFIG.clockMs;
  } catch {
    doc.hand = null;
    systemLine(doc, "could not start the hand — waiting");
  }
}

/** Enforce due clocks: expired action clocks fold/check; due next hands deal. */
function advanceDue(doc: RoomDoc, runner: TableRunner): void {
  for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
    const now = Date.now();
    if (doc.hand && runner.handActive() && doc.actorDeadlineAt !== null && doc.actorDeadlineAt <= now) {
      const actor = runner.currentActorId();
      if (!actor) {
        doc.actorDeadlineAt = null;
        continue;
      }
      const legal = runner.legalFor(actor);
      const fallback: PlayerAction = legal.some((a) => a.kind === "check")
        ? { kind: "check" }
        : { kind: "fold" };
      doc.hand.lastAction[actor] = fallback.kind === "check" ? "checks (clock)" : "folds (clock)";
      try {
        const events = apply(doc, runner, { type: "act", playerId: actor, action: fallback });
        consumeEvents(doc, events);
      } catch {
        doc.actorDeadlineAt = null;
        break;
      }
      if (doc.hand && runner.handActive()) doc.actorDeadlineAt = Date.now() + ROOM_CONFIG.clockMs;
      continue;
    }
    if (doc.phase === "playing" && !doc.hand && doc.nextHandAt !== null && doc.nextHandAt <= now) {
      startHandNow(doc, runner);
      continue;
    }
    break;
  }
  refreshClock(doc, runner);
}

/** When should a poller next check in? (ms epoch, or null if nothing scheduled) */
export function dueAt(doc: RoomDoc): number | null {
  const candidates = [doc.actorDeadlineAt, doc.nextHandAt].filter(
    (t): t is number => typeof t === "number",
  );
  return candidates.length ? Math.min(...candidates) : null;
}

async function mutate<T>(
  id: string,
  fn: (doc: RoomDoc, runner: TableRunner) => T,
): Promise<T | { error: string }> {
  const store = roomStore();
  const roomId = id.toUpperCase();
  return store.withLock(roomId, async () => {
    const doc = (await store.get(roomId)) as RoomDoc | null;
    if (!doc) return { error: "room not found" };
    const runner = runnerFrom(doc);
    advanceDue(doc, runner);
    const result = fn(doc, runner);
    advanceDue(doc, runner);
    doc.v += 1;
    await store.set(roomId, doc);
    return result;
  });
}

export async function createRoom(
  hostName: string,
): Promise<{ roomId: string; token: string; playerId: string } | { error: string }> {
  const name = sanitizeName(hostName);
  if (!name) return { error: "pick a name" };
  const store = roomStore();
  const id = roomCode();
  const token = randomBytes(10).toString("hex");
  const playerId = `${slug(name)}-1`;
  const doc: RoomDoc = {
    v: 1,
    id,
    createdAt: Date.now(),
    hostToken: token,
    phase: "waiting",
    commands: [],
    tokens: { [token]: playerId },
    names: { [playerId]: name },
    buyIns: { [playerId]: ROOM_CONFIG.buyIn },
    chat: [],
    reactions: [],
    seq: 0,
    hand: null,
    actorDeadlineAt: null,
    nextHandAt: null,
    handCounter: 0,
    settlement: null,
  };
  const runner = runnerFrom(doc);
  apply(doc, runner, { type: "seat-player", playerId, stack: ROOM_CONFIG.buyIn, seat: 0 });
  systemLine(doc, `${name} sits down with ${ROOM_CONFIG.buyIn.toLocaleString()} tokens`);
  await store.set(id, doc);
  return { roomId: id, token, playerId };
}

export async function joinRoom(
  id: string,
  rawName: string,
): Promise<{ token: string; playerId: string } | { error: string }> {
  const name = sanitizeName(rawName);
  if (!name) return { error: "pick a name" };
  return (await mutate(id, (doc, runner) => {
    if (doc.phase === "ended") return { error: "session is over" };
    if (Object.values(doc.names).some((n) => n.toLowerCase() === name.toLowerCase())) {
      return { error: "name taken at this table" };
    }
    if (Object.keys(doc.names).length >= ROOM_CONFIG.maxSeats) return { error: "table is full" };
    if (doc.hand) return { error: "hand in progress — try again between hands" };
    const playerId = `${slug(name)}-${Object.keys(doc.names).length + 1}`;
    try {
      apply(doc, runner, { type: "seat-player", playerId, stack: ROOM_CONFIG.buyIn });
    } catch {
      return { error: "could not seat you — try again between hands" };
    }
    const token = randomBytes(10).toString("hex");
    doc.tokens[token] = playerId;
    doc.names[playerId] = name;
    doc.buyIns[playerId] = ROOM_CONFIG.buyIn;
    systemLine(doc, `${name} sits down with ${ROOM_CONFIG.buyIn.toLocaleString()} tokens`);
    return { token, playerId };
  })) as { token: string; playerId: string } | { error: string };
}

export async function startRoom(id: string, token: string): Promise<{ ok: true } | { error: string }> {
  return (await mutate(id, (doc) => {
    if (token !== doc.hostToken) return { error: "only the host starts the game" };
    if (Object.keys(doc.names).length < 2) return { error: "need at least 2 players" };
    if (doc.phase !== "playing") {
      doc.phase = "playing";
      doc.nextHandAt = Date.now() + 800;
      systemLine(doc, "game on — first hand dealing");
    }
    return { ok: true as const };
  })) as { ok: true } | { error: string };
}

export async function endRoom(id: string, token: string): Promise<{ ok: true } | { error: string }> {
  return (await mutate(id, (doc, runner) => {
    if (token !== doc.hostToken) return { error: "only the host ends the session" };
    if (doc.hand) return { error: "finish the current hand first" };
    doc.phase = "ended";
    doc.nextHandAt = null;
    const stacks = runner.stacks();
    const nets = new Map<string, number>();
    const finalStacks = Object.entries(stacks).map(([playerId, stack]) => {
      const net = stack - (doc.buyIns[playerId] ?? 0);
      nets.set(playerId, net);
      return { name: doc.names[playerId] ?? playerId, stack, net };
    });
    const winners = [...nets.entries()]
      .filter(([, n]) => n > 0)
      .map(([p, n]) => ({ p, n }))
      .sort((a, b) => b.n - a.n);
    const losers = [...nets.entries()]
      .filter(([, n]) => n < 0)
      .map(([p, n]) => ({ p, n: -n }))
      .sort((a, b) => b.n - a.n);
    const pairs: Array<{ from: string; to: string; tokens: number }> = [];
    let wi = 0;
    let li = 0;
    while (wi < winners.length && li < losers.length) {
      const w = winners[wi]!;
      const l = losers[li]!;
      const amount = Math.min(w.n, l.n);
      if (amount > 0) {
        pairs.push({ from: doc.names[l.p] ?? l.p, to: doc.names[w.p] ?? w.p, tokens: amount });
      }
      w.n -= amount;
      l.n -= amount;
      if (w.n === 0) wi += 1;
      if (l.n === 0) li += 1;
    }
    doc.settlement = { finalStacks, pairs };
    systemLine(doc, "session over — settle up and talk your talk");
    return { ok: true as const };
  })) as { ok: true } | { error: string };
}

function resolveHumanAction(
  raw: { kind: string; amount?: number },
  legal: readonly LegalAction[],
): PlayerAction | null {
  const has = (k: string) => legal.some((a) => a.kind === k);
  const range = legal.find((a) => a.kind === "bet-to" || a.kind === "raise-to");
  switch (raw.kind) {
    case "fold":
      return has("fold") ? { kind: "fold" } : has("check") ? { kind: "check" } : null;
    case "check":
      return has("check") ? { kind: "check" } : null;
    case "call":
      return has("call") ? { kind: "call" } : null;
    case "bet-to":
    case "raise-to": {
      if (!range || (range.kind !== "bet-to" && range.kind !== "raise-to")) return null;
      if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount)) return null;
      const amount = Math.min(Math.max(Math.round(raw.amount), range.minAmount), range.maxAmount);
      return { kind: range.kind, amount };
    }
    default:
      return null;
  }
}

export async function actInRoom(
  id: string,
  token: string,
  raw: { kind: string; amount?: number },
  say?: string,
): Promise<{ ok: true } | { error: string }> {
  return (await mutate(id, (doc, runner) => {
    const playerId = doc.tokens[token];
    if (!playerId) return { error: "bad seat token" };
    if (!doc.hand || runner.currentActorId() !== playerId) return { error: "not your turn" };
    const legal = runner.legalFor(playerId);
    const action = resolveHumanAction(raw, legal);
    if (!action) return { error: "that action isn't available" };
    try {
      const events = apply(doc, runner, { type: "act", playerId, action });
      if (doc.hand) doc.hand.lastAction[playerId] = actionLabel(action);
      if (say) {
        const clean = sanitizeChat(say);
        if (clean) {
          doc.seq += 1;
          doc.chat.push({ seq: doc.seq, from: doc.names[playerId] ?? playerId, text: clean });
        }
      }
      consumeEvents(doc, events);
    } catch {
      return { error: "the engine rejected that — try again" };
    }
    if (doc.hand && runner.handActive()) doc.actorDeadlineAt = Date.now() + ROOM_CONFIG.clockMs;
    return { ok: true as const };
  })) as { ok: true } | { error: string };
}

export async function chatInRoom(
  id: string,
  token: string,
  text: string,
): Promise<{ ok: true } | { error: string }> {
  return (await mutate(id, (doc) => {
    const playerId = doc.tokens[token];
    if (!playerId) return { error: "bad seat token" };
    const clean = sanitizeChat(text);
    if (!clean) return { error: "say something" };
    doc.seq += 1;
    doc.chat.push({ seq: doc.seq, from: doc.names[playerId] ?? playerId, text: clean });
    if (doc.chat.length > 120) doc.chat.splice(0, doc.chat.length - 120);
    return { ok: true as const };
  })) as { ok: true } | { error: string };
}

export async function reactInRoom(
  id: string,
  token: string,
  emoji: string,
): Promise<{ ok: true } | { error: string }> {
  return (await mutate(id, (doc) => {
    const playerId = doc.tokens[token];
    if (!playerId) return { error: "bad seat token" };
    const clean = emoji.trim().slice(0, 8);
    if (!clean || /[\u0000-\u001f\u007f-\u009f<>&"'`]/.test(clean)) return { error: "unusable emoji" };
    doc.seq += 1;
    doc.reactions.push({ seq: doc.seq, from: doc.names[playerId] ?? playerId, emoji: clean });
    if (doc.reactions.length > 40) doc.reactions.splice(0, doc.reactions.length - 40);
    return { ok: true as const };
  })) as { ok: true } | { error: string };
}

export async function rebuyInRoom(id: string, token: string): Promise<{ ok: true } | { error: string }> {
  return (await mutate(id, (doc, runner) => {
    const playerId = doc.tokens[token];
    if (!playerId) return { error: "bad seat token" };
    if (doc.hand) return { error: "between hands only" };
    const stack = runner.stacks()[playerId] ?? 0;
    if (stack > 0) return { error: "you still have chips" };
    try {
      apply(doc, runner, { type: "add-chips", playerId, amount: ROOM_CONFIG.buyIn });
      apply(doc, runner, { type: "set-sitting-out", playerId, sittingOut: false });
    } catch {
      return { error: "rebuy failed" };
    }
    doc.buyIns[playerId] = (doc.buyIns[playerId] ?? 0) + ROOM_CONFIG.buyIn;
    systemLine(doc, `${doc.names[playerId] ?? playerId} rebuys for ${ROOM_CONFIG.buyIn.toLocaleString()}`);
    if (doc.phase === "playing" && doc.nextHandAt === null) {
      doc.nextHandAt = Date.now() + ROOM_CONFIG.interHandMs;
    }
    return { ok: true as const };
  })) as { ok: true } | { error: string };
}

/** Fire any due clocks (called by pollers when dueAt has passed). */
export async function advanceRoom(id: string): Promise<void> {
  await mutate(id, () => undefined).catch(() => undefined);
}

export async function loadRoomDoc(id: string): Promise<RoomDoc | null> {
  return ((await roomStore().get(id.toUpperCase())) as RoomDoc | null) ?? null;
}

function legalVM(legal: readonly LegalAction[]): LegalVM[] {
  return legal.map((a) => {
    if (a.kind === "call") return { kind: a.kind, amount: a.amount };
    if (a.kind === "bet-to" || a.kind === "raise-to") {
      return { kind: a.kind, min: a.minAmount, max: a.maxAmount };
    }
    return { kind: a.kind as "fold" | "check" };
  });
}

export function buildVM(doc: RoomDoc, viewerToken: string | null): TableVM {
  const runner = runnerFrom(doc);
  const viewerId = viewerToken ? (doc.tokens[viewerToken] ?? null) : null;
  const state = runner.state;
  const hand = state.hand;
  const actor = runner.currentActorId();
  const view = viewerId ? runner.playerView(viewerId) : runner.spectatorView();
  const handView = view.hand;

  const seats: SeatVM[] = [];
  for (const seat of state.seats) {
    if (!seat) continue;
    const inHand = handView?.players.find((p) => p.playerId === seat.playerId);
    const revealed = doc.hand?.revealed[seat.playerId];
    let holeCards: readonly string[] | null;
    if (revealed) holeCards = revealed;
    else if (inHand && !inHand.folded) {
      holeCards = inHand.holeCards ? inHand.holeCards.map(cardToString) : null;
    } else {
      holeCards = [];
    }
    seats.push({
      playerId: seat.playerId,
      name: doc.names[seat.playerId] ?? seat.playerId,
      seatType: "human",
      stack: seat.stack,
      folded: inHand?.folded ?? false,
      sittingOut: seat.status !== "active",
      holeCards,
      lastAction: doc.hand?.lastAction[seat.playerId] ?? null,
      committedStreet: inHand?.committedStreet ?? 0,
      isDealer: hand ? hand.buttonSeat === inHand?.seat : false,
      isActor: actor === seat.playerId,
    });
  }

  const pot = handView ? handView.players.reduce((sum, p) => sum + p.committedHand, 0) : 0;
  const youLegal = viewerId && actor === viewerId ? legalVM(runner.legalFor(viewerId)) : null;
  const myCards =
    handView?.players.find((p) => p.playerId === viewerId)?.holeCards?.map(cardToString) ?? [];

  return {
    table: doc.id,
    phase: doc.phase,
    handNo: doc.hand?.handNo ?? doc.handCounter,
    street: doc.hand?.street ?? "—",
    board: handView?.communityCards.map(cardToString) ?? [],
    pot,
    blinds: { small: ROOM_CONFIG.smallBlind, big: ROOM_CONFIG.bigBlind },
    chipsPerToken: {
      tokensPerChip: ROOM_CONFIG.tokensPerChip,
      referenceModel: ROOM_CONFIG.referenceModel,
    },
    seats,
    chat: doc.chat.slice(-40),
    reactions: doc.reactions.slice(-12),
    you: viewerId
      ? {
          playerId: viewerId,
          holeCards: myCards,
          legal: youLegal,
          deadlineAt: actor === viewerId ? doc.actorDeadlineAt : null,
        }
      : null,
    commit: doc.hand?.commit ?? null,
    settlement: doc.settlement,
  };
}
