"use client";

/**
 * Client for the LOCAL agent-arena table server (packages/table/src/web/server.ts).
 * Connects to ws://localhost:7787/ws, reduces the hello + event stream into the
 * shared TableVM, and exposes a send() for seated humans (act / chat / react).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatTokens,
  type ChatLineVM,
  type LegalVM,
  type ReactionVM,
  type SeatVM,
  type SettlementVM,
  type TableVM,
} from "./view-model";

export type TableStatus = "connecting" | "live" | "offline";

export interface LocalTable {
  readonly vm: TableVM;
  readonly status: TableStatus;
  readonly send: (message: Record<string, unknown>) => void;
}

// ---------- internal mutable state ----------

interface SeatRec {
  playerId: string;
  name: string;
  seatType: SeatVM["seatType"];
  seat: number;
  stack: number;
  stackAtHandStart: number;
  folded: boolean;
  sittingOut: boolean;
  holeCards: string[] | null; // null = face-down backs, [] = no cards
  lastAction: string | null;
  committedStreet: number;
}

interface ClientState {
  table: string;
  phase: TableVM["phase"];
  handNo: number;
  street: string;
  board: string[];
  pot: number;
  blinds: { small: number; big: number };
  chips: { tokensPerChip: number; referenceModel: string };
  seats: Map<string, SeatRec>;
  buttonSeat: number | null;
  actor: { playerId: string; deadlineAt: number } | null;
  chat: ChatLineVM[];
  reactions: ReactionVM[];
  lineSeq: number;
  you: { playerId: string; name: string } | null;
  youHole: string[];
  youLegal: LegalVM[] | null;
  youDeadline: number | null;
  commit: string | null;
  buyIns: Map<string, number>;
  settlement: SettlementVM | null;
}

function newState(): ClientState {
  return {
    table: "",
    phase: "waiting",
    handNo: 0,
    street: "preflop",
    board: [],
    pot: 0,
    blinds: { small: 0, big: 0 },
    chips: { tokensPerChip: 0, referenceModel: "" },
    seats: new Map(),
    buttonSeat: null,
    actor: null,
    chat: [],
    reactions: [],
    lineSeq: 0,
    you: null,
    youHole: [],
    youLegal: null,
    youDeadline: null,
    commit: null,
    buyIns: new Map(),
    settlement: null,
  };
}

const EMPTY_VM: TableVM = buildVM(newState());

// ---------- helpers ----------

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec {
  return typeof value === "object" && value !== null ? (value as Rec) : {};
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Engine cards arrive as {rank, suit} objects; seat views use "As" strings. */
function cardCode(value: unknown): string {
  if (typeof value === "string") return value;
  const c = asRec(value);
  return `${str(c.rank)}${str(c.suit)}`;
}

function cardCodes(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cardCode).filter((c) => c.length > 0) : [];
}

const SEAT_TYPES: ReadonlyArray<SeatVM["seatType"]> = ["human", "model", "acp", "mcp"];

function seatType(value: unknown): SeatVM["seatType"] {
  return SEAT_TYPES.find((t) => t === value) ?? "model";
}

function seatOf(state: ClientState, playerId: string): SeatRec {
  let rec = state.seats.get(playerId);
  if (!rec) {
    rec = {
      playerId,
      name: playerId.slice(0, 8),
      seatType: "model",
      seat: state.seats.size,
      stack: 0,
      stackAtHandStart: 0,
      folded: false,
      sittingOut: false,
      holeCards: [],
      lastAction: null,
      committedStreet: 0,
    };
    state.seats.set(playerId, rec);
  }
  return rec;
}

function nameOf(state: ClientState, playerId: string): string {
  return state.seats.get(playerId)?.name ?? playerId.slice(0, 8);
}

function pushChat(state: ClientState, from: string, text: string, system?: boolean): void {
  state.lineSeq += 1;
  state.chat.push(system ? { seq: state.lineSeq, from, text, system: true } : { seq: state.lineSeq, from, text });
  if (state.chat.length > 40) state.chat.splice(0, state.chat.length - 40);
}

function pushReaction(state: ClientState, from: string, emoji: string): void {
  state.lineSeq += 1;
  state.reactions.push({ seq: state.lineSeq, from, emoji });
  if (state.reactions.length > 12) state.reactions.splice(0, state.reactions.length - 12);
}

function actionLabel(action: Rec): string {
  const amount = num(action.amount, NaN);
  switch (action.kind) {
    case "fold":
      return "folds";
    case "check":
      return "checks";
    case "call":
      return Number.isFinite(amount) ? `calls ${formatTokens(amount)}` : "calls";
    case "bet-to":
      return `bets ${formatTokens(num(action.amount))}`;
    case "raise-to":
      return `raises to ${formatTokens(num(action.amount))}`;
    default:
      return str(action.kind);
  }
}

const LEGAL_KINDS: ReadonlyArray<LegalVM["kind"]> = ["fold", "check", "call", "bet-to", "raise-to"];

/** act_request legal entries come as {kind, amount?, min?, max?} (SeatView.legal). */
function toLegal(raw: unknown): LegalVM[] {
  if (!Array.isArray(raw)) return [];
  const out: LegalVM[] = [];
  for (const entry of raw) {
    const rec = asRec(entry);
    const kind = LEGAL_KINDS.find((k) => k === rec.kind);
    if (!kind) continue;
    const min = typeof rec.min === "number" ? rec.min : rec.minAmount;
    const max = typeof rec.max === "number" ? rec.max : rec.maxAmount;
    out.push({
      kind,
      ...(typeof rec.amount === "number" ? { amount: rec.amount } : {}),
      ...(typeof min === "number" ? { min } : {}),
      ...(typeof max === "number" ? { max } : {}),
    });
  }
  return out;
}

/** Greedy net-settlement: losers pay winners, largest first. */
function settlePairs(
  nets: ReadonlyArray<{ name: string; net: number }>,
): Array<{ from: string; to: string; tokens: number }> {
  const winners = nets.filter((n) => n.net > 0).map((n) => ({ ...n })).sort((a, b) => b.net - a.net);
  const losers = nets.filter((n) => n.net < 0).map((n) => ({ name: n.name, owes: -n.net })).sort((a, b) => b.owes - a.owes);
  const pairs: Array<{ from: string; to: string; tokens: number }> = [];
  let w = 0;
  let l = 0;
  while (w < winners.length && l < losers.length) {
    const winner = winners[w]!;
    const loser = losers[l]!;
    const tokens = Math.min(winner.net, loser.owes);
    if (tokens > 0) pairs.push({ from: loser.name, to: winner.name, tokens });
    winner.net -= tokens;
    loser.owes -= tokens;
    if (winner.net <= 0) w += 1;
    if (loser.owes <= 0) l += 1;
  }
  return pairs;
}

// ---------- reducers ----------

function onHello(msg: Rec): ClientState {
  // Server replays the full backlog after hello — start from scratch.
  const fresh = newState();
  fresh.table = str(msg.table);
  const you = asRec(msg.you);
  fresh.you = typeof you.playerId === "string" ? { playerId: str(you.playerId), name: str(you.name) } : null;
  const chips = asRec(msg.chips);
  fresh.chips = { tokensPerChip: num(chips.tokensPerChip), referenceModel: str(chips.referenceModel) };
  const blinds = asRec(msg.blinds);
  fresh.blinds = { small: num(blinds.small), big: num(blinds.big) };
  const players = Array.isArray(msg.players) ? msg.players : [];
  players.forEach((p, i) => {
    const rec = asRec(p);
    const playerId = str(rec.playerId);
    if (!playerId) return;
    const seat = seatOf(fresh, playerId);
    seat.name = str(rec.name, seat.name);
    seat.seatType = seatType(rec.seatType);
    seat.seat = i;
  });
  return fresh;
}

function onEngineEvent(state: ClientState, event: Rec): void {
  switch (event.type) {
    case "hand-started": {
      state.phase = "playing";
      state.handNo = num(event.handNumber, state.handNo + 1);
      state.board = [];
      state.pot = 0;
      state.street = "preflop";
      state.buttonSeat = num(event.buttonSeat, -1);
      state.actor = null;
      state.youHole = [];
      state.youLegal = null;
      state.youDeadline = null;
      for (const seat of state.seats.values()) {
        seat.folded = false;
        seat.holeCards = [];
        seat.lastAction = null;
        seat.committedStreet = 0;
        seat.stackAtHandStart = seat.stack;
      }
      pushChat(state, "table", `— Hand #${state.handNo} —`, true);
      break;
    }
    case "forced-bet-posted": {
      const seat = seatOf(state, str(event.playerId));
      const amount = num(event.amount);
      const label = event.kind === "small-blind" ? "SB" : event.kind === "big-blind" ? "BB" : "ante";
      seat.lastAction = `posts ${label} ${formatTokens(amount)}`;
      seat.stack -= amount;
      seat.committedStreet += amount;
      state.pot += amount;
      break;
    }
    case "hole-cards-dealt": {
      const playerId = str(event.playerId);
      const seat = seatOf(state, playerId);
      // cards: null = redacted for this viewer -> render face-down backs.
      seat.holeCards = event.cards == null ? null : cardCodes(event.cards);
      if (state.you && playerId === state.you.playerId && event.cards != null) {
        state.youHole = cardCodes(event.cards);
      }
      break;
    }
    case "player-acted": {
      const playerId = str(event.playerId);
      const seat = seatOf(state, playerId);
      const action = asRec(event.action);
      const paid = num(event.paid);
      seat.lastAction = actionLabel(action);
      if (action.kind === "fold") seat.folded = true;
      seat.stack -= paid;
      seat.committedStreet += paid;
      state.pot += paid;
      if (state.actor?.playerId === playerId) state.actor = null;
      if (state.you && playerId === state.you.playerId) {
        state.youLegal = null;
        state.youDeadline = null;
      }
      break;
    }
    case "street-dealt": {
      state.board.push(...cardCodes(event.cards));
      state.street = str(event.street, state.street);
      for (const seat of state.seats.values()) seat.committedStreet = 0;
      break;
    }
    case "cards-revealed": {
      const seat = seatOf(state, str(event.playerId));
      seat.holeCards = cardCodes(event.cards);
      break;
    }
    case "pot-awarded": {
      const amount = num(event.amount);
      state.pot = Math.max(0, state.pot - amount);
      const awards = Array.isArray(event.awards) ? event.awards : [];
      for (const award of awards) {
        const rec = asRec(award);
        seatOf(state, str(rec.playerId)).stack += num(rec.amount);
      }
      break;
    }
    case "uncalled-bet-returned": {
      const amount = num(event.amount);
      seatOf(state, str(event.playerId)).stack += amount;
      state.pot = Math.max(0, state.pot - amount);
      break;
    }
    case "hand-completed": {
      state.actor = null;
      break;
    }
    case "player-seated": {
      const seat = seatOf(state, str(event.playerId));
      if (typeof event.seat === "number") seat.seat = event.seat;
      if (typeof event.stack === "number") seat.stack = event.stack;
      break;
    }
    case "chips-added": {
      seatOf(state, str(event.playerId)).stack += num(event.amount);
      break;
    }
    case "player-sitting-out-changed": {
      seatOf(state, str(event.playerId)).sittingOut = Boolean(event.sittingOut);
      break;
    }
    default:
      break;
  }
}

function onLoggedEvent(state: ClientState, ev: Rec): void {
  switch (ev.type) {
    case "session_started": {
      state.phase = "playing";
      const players = Array.isArray(ev.players) ? ev.players : [];
      for (const p of players) {
        const rec = asRec(p);
        const playerId = str(rec.playerId);
        if (playerId && rec.name) seatOf(state, playerId).name = str(rec.name);
      }
      break;
    }
    case "buy_in": {
      const playerId = str(ev.playerId);
      state.buyIns.set(playerId, (state.buyIns.get(playerId) ?? 0) + num(ev.tokens));
      break;
    }
    case "deck_committed": {
      if (typeof ev.commit === "string") state.commit = ev.commit;
      break;
    }
    case "seed_revealed": {
      pushChat(state, "table", `Seed revealed for hand #${num(ev.handNo)} — deal verifiable`, true);
      break;
    }
    case "engine_event": {
      onEngineEvent(state, asRec(ev.event));
      break;
    }
    case "action_requested": {
      const deadlineMs = num(ev.deadlineMs);
      const deadlineAt = deadlineMs > 1e11 ? deadlineMs : Date.now() + deadlineMs;
      state.actor = { playerId: str(ev.playerId), deadlineAt };
      break;
    }
    case "action_decided": {
      if (ev.fallback) {
        const kind = str(asRec(ev.action).kind, "fold");
        pushChat(state, "table", `${nameOf(state, str(ev.playerId))}: auto-${kind} (${str(ev.fallback)})`, true);
      }
      break;
    }
    case "chat_said": {
      pushChat(state, nameOf(state, str(ev.playerId)), str(ev.text));
      break;
    }
    case "reaction_added": {
      pushReaction(state, nameOf(state, str(ev.playerId)), str(ev.emoji));
      break;
    }
    case "hand_settled": {
      const deltas = asRec(ev.deltasTokens);
      const parts: string[] = [];
      for (const [playerId, delta] of Object.entries(deltas)) {
        const seat = seatOf(state, playerId);
        const d = num(delta);
        // Authoritative reconcile: trust the settle over live tracking.
        seat.stack = seat.stackAtHandStart + d;
        if (d !== 0) parts.push(`${seat.name} ${d > 0 ? "+" : ""}${formatTokens(d)}`);
      }
      if (parts.length > 0) pushChat(state, "table", `Settled: ${parts.join(" · ")}`, true);
      break;
    }
    case "session_ended": {
      state.phase = "ended";
      state.actor = null;
      state.youLegal = null;
      state.youDeadline = null;
      const finals = asRec(ev.finalStacks);
      const rows = Object.entries(finals).map(([playerId, stack]) => ({
        name: nameOf(state, playerId),
        stack: num(stack),
        net: num(stack) - (state.buyIns.get(playerId) ?? 0),
      }));
      rows.sort((a, b) => b.stack - a.stack);
      state.settlement = { finalStacks: rows, pairs: settlePairs(rows) };
      pushChat(state, "table", ev.aborted ? `Session aborted — ${str(ev.aborted)}` : "Session ended", true);
      break;
    }
    default:
      break;
  }
}

function onActRequest(state: ClientState, msg: Rec): void {
  const view = asRec(msg.view);
  state.youLegal = toLegal(msg.legal ?? view.legal);
  state.youDeadline = num(msg.deadlineAt, Date.now());
  const hole = cardCodes(view.yourHoleCards);
  if (hole.length > 0) state.youHole = hole;
  if (state.you) {
    state.actor = { playerId: state.you.playerId, deadlineAt: state.youDeadline };
    const seat = seatOf(state, state.you.playerId);
    if (hole.length > 0) seat.holeCards = hole;
  }
}

// ---------- VM projection ----------

function buildVM(state: ClientState): TableVM {
  const seats = [...state.seats.values()]
    .sort((a, b) => a.seat - b.seat)
    .map(
      (seat): SeatVM => ({
        playerId: seat.playerId,
        name: seat.name,
        seatType: seat.seatType,
        stack: seat.stack,
        folded: seat.folded,
        sittingOut: seat.sittingOut,
        holeCards: seat.holeCards === null ? null : [...seat.holeCards],
        lastAction: seat.lastAction,
        committedStreet: seat.committedStreet,
        isDealer: state.buttonSeat !== null && seat.seat === state.buttonSeat,
        isActor: state.actor?.playerId === seat.playerId,
      }),
    );
  return {
    table: state.table,
    phase: state.phase,
    handNo: state.handNo,
    street: state.street,
    board: [...state.board],
    pot: state.pot,
    blinds: state.blinds,
    chipsPerToken: state.chips,
    seats,
    chat: [...state.chat],
    reactions: [...state.reactions],
    you: state.you
      ? {
          playerId: state.you.playerId,
          holeCards: [...state.youHole],
          legal: state.youLegal,
          deadlineAt: state.youDeadline,
        }
      : null,
    commit: state.commit,
    settlement: state.settlement,
  };
}

// ---------- the hook ----------

/**
 * Connect to the local table server and reduce its stream into a TableVM.
 * Pass null to stay idle (status "connecting") until a URL is known.
 * Reconnects with backoff; reports "offline" after two failed attempts but
 * keeps retrying quietly so the page recovers when the server comes up.
 */
export function useLocalTable(url: string | null): LocalTable {
  const [vm, setVm] = useState<TableVM>(EMPTY_VM);
  const [status, setStatus] = useState<TableStatus>("connecting");
  const stateRef = useRef<ClientState>(newState());
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (!url) {
      setStatus("connecting");
      return;
    }
    let disposed = false;
    let attempts = 0;
    let retryTimer: number | null = null;
    let flushTimer: number | null = null;

    const flush = (): void => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        if (!disposed) setVm(buildVM(stateRef.current));
      }, 16);
    };

    const handleFrame = (raw: string): void => {
      let msg: Rec;
      try {
        msg = asRec(JSON.parse(raw));
      } catch {
        return;
      }
      switch (msg.t) {
        case "hello":
          stateRef.current = onHello(msg);
          break;
        case "event":
          onLoggedEvent(stateRef.current, asRec(msg.ev));
          break;
        case "act_request":
          onActRequest(stateRef.current, msg);
          break;
        default:
          return;
      }
      flush();
    };

    const scheduleRetry = (): void => {
      attempts += 1;
      setStatus(attempts >= 2 ? "offline" : "connecting");
      const delay = Math.min(600 * 2 ** Math.min(attempts, 4), 8000);
      retryTimer = window.setTimeout(connect, delay);
    };

    const connect = (): void => {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        if (disposed) return;
        attempts = 0;
        setStatus("live");
      };
      ws.onmessage = (event) => {
        if (disposed) return;
        handleFrame(String(event.data));
      };
      ws.onclose = () => {
        if (disposed || wsRef.current !== ws) return;
        wsRef.current = null;
        scheduleRetry();
      };
    };

    stateRef.current = newState();
    setVm(EMPTY_VM);
    setStatus("connecting");
    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [url]);

  return { vm, status, send };
}
