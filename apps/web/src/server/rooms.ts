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
} from "@table-stakes/engine";
import type {
  ChatLineVM,
  LegalVM,
  ReactionVM,
  SeatVM,
  SettlementVM,
  TableVM,
} from "@/lib/view-model";

/**
 * Human-mode rooms: an in-memory, engine-backed cash table per room code.
 * Everything a client sees is a personalized TableVM snapshot over SSE.
 *
 * V1 honesty: rooms live in this serverless instance's memory. At friendly
 * traffic Vercel's Fluid compute keeps one warm instance and this holds up;
 * durable rooms are the Supabase tier, later.
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

interface Subscriber {
  readonly playerId: string | null;
  readonly send: (vm: TableVM) => void;
  readonly close: () => void;
}

interface HandCtx {
  readonly handNo: number;
  readonly commit: string;
  street: string;
  /** Cards revealed at showdown, visible to everyone. */
  readonly revealed: Map<string, readonly string[]>;
  readonly lastAction: Map<string, string>;
}

export interface Room {
  readonly id: string;
  readonly createdAt: number;
  readonly hostToken: string;
  phase: "waiting" | "playing" | "ended";
  runner: TableRunner;
  readonly tokens: Map<string, string>; // seat token -> playerId
  readonly names: Map<string, string>; // playerId -> display name
  readonly buyIns: Map<string, number>;
  readonly subscribers: Set<Subscriber>;
  readonly chat: ChatLineVM[];
  readonly reactions: ReactionVM[];
  seq: number;
  hand: HandCtx | null;
  actorDeadlineAt: number | null;
  turnTimer: ReturnType<typeof setTimeout> | null;
  nextHandTimer: ReturnType<typeof setTimeout> | null;
  handCounter: number;
  settlement: SettlementVM | null;
  touchedAt: number;
}

const rooms = new Map<string, Room>();

const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
function sweepRooms(): void {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.touchedAt > ROOM_TTL_MS) {
      for (const sub of room.subscribers) sub.close();
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
      rooms.delete(id);
    }
  }
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

export function createRoom(hostName: string): { roomId: string; token: string; playerId: string } {
  sweepRooms();
  const id = roomCode();
  const room: Room = {
    id,
    createdAt: Date.now(),
    hostToken: "",
    phase: "waiting",
    runner: new TableRunner({
      smallBlind: ROOM_CONFIG.smallBlind,
      bigBlind: ROOM_CONFIG.bigBlind,
      minBuyIn: ROOM_CONFIG.buyIn,
      maxBuyIn: ROOM_CONFIG.buyIn * 5,
      maxSeats: ROOM_CONFIG.maxSeats,
    }),
    tokens: new Map(),
    names: new Map(),
    buyIns: new Map(),
    subscribers: new Set(),
    chat: [],
    reactions: [],
    seq: 0,
    hand: null,
    actorDeadlineAt: null,
    turnTimer: null,
    nextHandTimer: null,
    handCounter: 0,
    settlement: null,
    touchedAt: Date.now(),
  };
  rooms.set(id, room);
  const joined = joinRoom(id, hostName);
  if (!joined.ok) throw new Error("host join failed");
  (room as { hostToken: string }).hostToken = joined.token;
  return { roomId: id, token: joined.token, playerId: joined.playerId };
}

export function getRoom(id: string): Room | null {
  return rooms.get(id.toUpperCase()) ?? null;
}

export function joinRoom(
  id: string,
  rawName: string,
): { ok: true; token: string; playerId: string } | { ok: false; error: string } {
  const room = getRoom(id);
  if (!room) return { ok: false, error: "room not found" };
  if (room.phase === "ended") return { ok: false, error: "session is over" };
  const name = sanitizeName(rawName);
  if (!name) return { ok: false, error: "pick a name" };
  if ([...room.names.values()].some((n) => n.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: "name taken at this table" };
  }
  if (room.names.size >= ROOM_CONFIG.maxSeats) return { ok: false, error: "table is full" };
  if (room.hand) return { ok: false, error: "hand in progress — try between hands" };

  const playerId = `${slug(name)}-${room.names.size + 1}`;
  try {
    room.runner.seatPlayer(playerId, ROOM_CONFIG.buyIn);
  } catch {
    return { ok: false, error: "could not seat you (hand in progress?)" };
  }
  const token = randomBytes(10).toString("hex");
  room.tokens.set(token, playerId);
  room.names.set(playerId, name);
  room.buyIns.set(playerId, ROOM_CONFIG.buyIn);
  systemLine(room, `${name} sits down with ${ROOM_CONFIG.buyIn.toLocaleString()} tokens`);
  touch(room);
  broadcast(room);
  return { ok: true, token, playerId };
}

function touch(room: Room): void {
  room.touchedAt = Date.now();
}

function systemLine(room: Room, text: string): void {
  room.seq += 1;
  room.chat.push({ seq: room.seq, from: "table", text, system: true });
  if (room.chat.length > 120) room.chat.splice(0, room.chat.length - 120);
}

export function startRoom(id: string, token: string): { ok: boolean; error?: string } {
  const room = getRoom(id);
  if (!room) return { ok: false, error: "room not found" };
  if (token !== room.hostToken) return { ok: false, error: "only the host starts the game" };
  if (room.names.size < 2) return { ok: false, error: "need at least 2 players" };
  if (room.phase === "playing") return { ok: true };
  room.phase = "playing";
  systemLine(room, "game on — first hand dealing");
  scheduleNextHand(room, 800);
  broadcast(room);
  return { ok: true };
}

export function endRoom(id: string, token: string): { ok: boolean; error?: string } {
  const room = getRoom(id);
  if (!room) return { ok: false, error: "room not found" };
  if (token !== room.hostToken) return { ok: false, error: "only the host ends the session" };
  if (room.hand) return { ok: false, error: "finish the current hand first" };
  finishSession(room);
  return { ok: true };
}

function finishSession(room: Room): void {
  room.phase = "ended";
  if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
  const stacks = room.runner.stacks();
  const nets = new Map<string, number>();
  const finalStacks = Object.entries(stacks).map(([playerId, stack]) => {
    const net = stack - (room.buyIns.get(playerId) ?? 0);
    nets.set(playerId, net);
    return { name: room.names.get(playerId) ?? playerId, stack, net };
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
      pairs.push({
        from: room.names.get(l.p) ?? l.p,
        to: room.names.get(w.p) ?? w.p,
        tokens: amount,
      });
    }
    w.n -= amount;
    l.n -= amount;
    if (w.n === 0) wi += 1;
    if (l.n === 0) li += 1;
  }
  room.settlement = { finalStacks, pairs };
  systemLine(room, "session over — settle up and talk your talk");
  broadcast(room);
}

function scheduleNextHand(room: Room, delayMs: number): void {
  if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
  room.nextHandTimer = setTimeout(() => startHand(room), delayMs);
}

function startHand(room: Room): void {
  if (room.phase !== "playing" || room.hand) return;
  // Sit out busted players.
  for (const [playerId, stack] of Object.entries(room.runner.stacks())) {
    const seat = room.runner.state.seats.find((s) => s?.playerId === playerId);
    if (stack <= 0 && seat?.status === "active") {
      try {
        room.runner.setSittingOut(playerId, true);
      } catch {
        /* between-hands only; safe to skip */
      }
    }
  }
  const playable = Object.entries(room.runner.stacks()).filter(([playerId, stack]) => {
    const seat = room.runner.state.seats.find((s) => s?.playerId === playerId);
    return stack > 0 && seat?.status === "active";
  });
  if (playable.length < 2) {
    systemLine(room, "waiting for at least two stacks — rebuy or invite someone");
    broadcast(room);
    return;
  }

  room.handCounter += 1;
  const serverSeed = newServerSeed();
  const seeds = playable.map(() => newClientSeed());
  const deck = deriveDeck({ serverSeed, clientSeeds: seeds, nonce: room.handCounter });
  const ctx: HandCtx = {
    handNo: room.handCounter,
    commit: commitment(serverSeed),
    street: "preflop",
    revealed: new Map(),
    lastAction: new Map(),
  };
  room.hand = ctx;
  try {
    consumeEvents(room, room.runner.startHand(deck));
  } catch {
    room.hand = null;
    systemLine(room, "could not start the hand — waiting");
    broadcast(room);
    return;
  }
  armTurnClock(room);
  broadcast(room);
}

function consumeEvents(room: Room, events: readonly DomainEvent[]): void {
  const ctx = room.hand;
  for (const event of events) {
    if (!ctx) break;
    switch (event.type) {
      case "street-dealt":
        ctx.street = event.street;
        break;
      case "player-acted": {
        const name = room.names.get(event.playerId) ?? event.playerId;
        const a = event.action;
        const label =
          a.kind === "bet-to"
            ? `bets ${a.amount.toLocaleString()}`
            : a.kind === "raise-to"
              ? `raises to ${a.amount.toLocaleString()}`
              : a.kind === "fold"
                ? "folds"
                : a.kind === "check"
                  ? "checks"
                  : `calls ${event.paid.toLocaleString()}`;
        ctx.lastAction.set(event.playerId, label.split(" ")[0] === "bets" ? label : label);
        void name;
        break;
      }
      case "cards-revealed":
        ctx.revealed.set(event.playerId, event.cards.map(cardToString));
        break;
      case "pot-awarded":
        for (const award of event.awards) {
          systemLine(
            room,
            `${room.names.get(award.playerId) ?? award.playerId} wins ${award.amount.toLocaleString()} tokens`,
          );
        }
        break;
      case "hand-completed":
        finishHand(room);
        break;
      default:
        break;
    }
  }
}

function finishHand(room: Room): void {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.actorDeadlineAt = null;
  room.hand = null;
  if (room.phase === "playing") scheduleNextHand(room, ROOM_CONFIG.interHandMs);
}

function armTurnClock(room: Room): void {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.actorDeadlineAt = null;
  if (!room.hand || !room.runner.handActive()) return;
  const actor = room.runner.currentActorId();
  if (!actor) return;
  room.actorDeadlineAt = Date.now() + ROOM_CONFIG.clockMs;
  room.turnTimer = setTimeout(() => {
    const current = room.runner.currentActorId();
    if (!current || !room.hand) return;
    const legal = room.runner.legalFor(current);
    const fallback: PlayerAction = legal.some((a) => a.kind === "check")
      ? { kind: "check" }
      : { kind: "fold" };
    room.hand.lastAction.set(current, fallback.kind === "check" ? "checks (clock)" : "folds (clock)");
    try {
      consumeEvents(room, room.runner.act(current, fallback));
    } catch {
      /* engine state advanced under us; next broadcast reconciles */
    }
    armTurnClock(room);
    broadcast(room);
  }, ROOM_CONFIG.clockMs + 500);
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

export function actInRoom(
  id: string,
  token: string,
  raw: { kind: string; amount?: number },
  say?: string,
): { ok: boolean; error?: string } {
  const room = getRoom(id);
  if (!room) return { ok: false, error: "room not found" };
  const playerId = room.tokens.get(token);
  if (!playerId) return { ok: false, error: "bad seat token" };
  if (!room.hand || room.runner.currentActorId() !== playerId) {
    return { ok: false, error: "not your turn" };
  }
  const legal = room.runner.legalFor(playerId);
  const action = resolveHumanAction(raw, legal);
  if (!action) return { ok: false, error: "that action isn't available" };
  try {
    const events = room.runner.act(playerId, action);
    if (room.hand) {
      const label =
        action.kind === "bet-to"
          ? `bets ${action.amount.toLocaleString()}`
          : action.kind === "raise-to"
            ? `raises to ${action.amount.toLocaleString()}`
            : action.kind;
      room.hand.lastAction.set(playerId, label);
    }
    if (say) chatInRoom(id, token, say);
    consumeEvents(room, events);
  } catch {
    return { ok: false, error: "the engine rejected that — try again" };
  }
  armTurnClock(room);
  touch(room);
  broadcast(room);
  return { ok: true };
}

export function chatInRoom(id: string, token: string, text: string): { ok: boolean; error?: string } {
  const room = getRoom(id);
  if (!room) return { ok: false, error: "room not found" };
  const playerId = room.tokens.get(token);
  if (!playerId) return { ok: false, error: "bad seat token" };
  const clean = sanitizeChat(text);
  if (!clean) return { ok: false, error: "say something" };
  room.seq += 1;
  room.chat.push({ seq: room.seq, from: room.names.get(playerId) ?? playerId, text: clean });
  if (room.chat.length > 120) room.chat.splice(0, room.chat.length - 120);
  touch(room);
  broadcast(room);
  return { ok: true };
}

export function reactInRoom(id: string, token: string, emoji: string): { ok: boolean; error?: string } {
  const room = getRoom(id);
  if (!room) return { ok: false, error: "room not found" };
  const playerId = room.tokens.get(token);
  if (!playerId) return { ok: false, error: "bad seat token" };
  const clean = emoji.trim().slice(0, 8);
  if (!clean || /[\u0000-\u001f\u007f-\u009f<>&"'`]/.test(clean)) {
    return { ok: false, error: "unusable emoji" };
  }
  room.seq += 1;
  room.reactions.push({ seq: room.seq, from: room.names.get(playerId) ?? playerId, emoji: clean });
  if (room.reactions.length > 40) room.reactions.splice(0, room.reactions.length - 40);
  touch(room);
  broadcast(room);
  return { ok: true };
}

export function rebuyInRoom(id: string, token: string): { ok: boolean; error?: string } {
  const room = getRoom(id);
  if (!room) return { ok: false, error: "room not found" };
  const playerId = room.tokens.get(token);
  if (!playerId) return { ok: false, error: "bad seat token" };
  if (room.hand) return { ok: false, error: "between hands only" };
  const stack = room.runner.stacks()[playerId] ?? 0;
  if (stack > 0) return { ok: false, error: "you still have chips" };
  try {
    room.runner.dispatch({ type: "add-chips", playerId, amount: ROOM_CONFIG.buyIn });
    room.runner.setSittingOut(playerId, false);
  } catch {
    return { ok: false, error: "rebuy failed" };
  }
  room.buyIns.set(playerId, (room.buyIns.get(playerId) ?? 0) + ROOM_CONFIG.buyIn);
  systemLine(room, `${room.names.get(playerId) ?? playerId} rebuys for ${ROOM_CONFIG.buyIn.toLocaleString()}`);
  touch(room);
  broadcast(room);
  return { ok: true };
}

export function subscribe(
  id: string,
  token: string | null,
  send: (vm: TableVM) => void,
  close: () => void,
): (() => void) | null {
  const room = getRoom(id);
  if (!room) return null;
  const playerId = token ? (room.tokens.get(token) ?? null) : null;
  const sub: Subscriber = { playerId, send, close };
  room.subscribers.add(sub);
  touch(room);
  send(buildVM(room, playerId));
  return () => room.subscribers.delete(sub);
}

function broadcast(room: Room): void {
  for (const sub of room.subscribers) {
    try {
      sub.send(buildVM(room, sub.playerId));
    } catch {
      room.subscribers.delete(sub);
    }
  }
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

export function buildVM(room: Room, viewerId: string | null): TableVM {
  const state = room.runner.state;
  const hand = state.hand;
  const actor = room.runner.currentActorId();
  const view = viewerId
    ? room.runner.playerView(viewerId)
    : room.runner.spectatorView();
  const handView = view.hand;

  const seats: SeatVM[] = [];
  for (const seat of state.seats) {
    if (!seat) continue;
    const inHand = handView?.players.find((p) => p.playerId === seat.playerId);
    const revealed = room.hand?.revealed.get(seat.playerId);
    let holeCards: readonly string[] | null = null;
    if (revealed) holeCards = revealed;
    else if (inHand && !inHand.folded) {
      holeCards = inHand.holeCards ? inHand.holeCards.map(cardToString) : null;
    } else {
      holeCards = [];
    }
    seats.push({
      playerId: seat.playerId,
      name: room.names.get(seat.playerId) ?? seat.playerId,
      seatType: "human",
      stack: seat.stack,
      folded: inHand?.folded ?? false,
      sittingOut: seat.status !== "active",
      holeCards,
      lastAction: room.hand?.lastAction.get(seat.playerId) ?? null,
      committedStreet: inHand?.committedStreet ?? 0,
      isDealer: hand ? hand.buttonSeat === inHand?.seat : false,
      isActor: actor === seat.playerId,
    });
  }

  const pot = handView
    ? handView.players.reduce((sum, p) => sum + p.committedHand, 0)
    : 0;

  const youLegal =
    viewerId && actor === viewerId ? legalVM(room.runner.legalFor(viewerId)) : null;
  const myCards =
    handView?.players.find((p) => p.playerId === viewerId)?.holeCards?.map(cardToString) ?? [];

  return {
    table: room.id,
    phase: room.phase,
    handNo: room.hand?.handNo ?? room.handCounter,
    street: room.hand?.street ?? "—",
    board: handView?.communityCards.map(cardToString) ?? [],
    pot,
    blinds: { small: ROOM_CONFIG.smallBlind, big: ROOM_CONFIG.bigBlind },
    chipsPerToken: {
      tokensPerChip: ROOM_CONFIG.tokensPerChip,
      referenceModel: ROOM_CONFIG.referenceModel,
    },
    seats,
    chat: room.chat.slice(-40),
    reactions: room.reactions.slice(-12),
    you: viewerId
      ? {
          playerId: viewerId,
          holeCards: myCards,
          legal: youLegal,
          deadlineAt: actor === viewerId ? room.actorDeadlineAt : null,
        }
      : null,
    commit: room.hand?.commit ?? null,
    settlement: room.settlement,
  };
}
