import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import type { LoggedEvent } from "@table-stakes/engine";
import { sanitizeEmoji, sanitizeSay } from "../seats/driver.ts";
import type { ActionBus, PendingTurn } from "../seats/bus.ts";

export interface TableWebOptions {
  readonly port: number;
  readonly indexHtmlPath: string;
  readonly table: string;
  readonly players: ReadonlyArray<{ playerId: string; name: string; seatType: string }>;
  readonly chips: { readonly tokensPerChip: number; readonly referenceModel: string };
  readonly blinds: { readonly small: number; readonly big: number };
  /** seat token → playerId, for human/mcp seats joining from outside. */
  readonly seatTokens: ReadonlyMap<string, string>;
  readonly chat: { readonly enabled: boolean; readonly maxChars: number; readonly reactions: boolean };
  readonly bus: ActionBus;
  readonly onChat: (playerId: string, text: string) => void;
  readonly onReact: (playerId: string, emoji: string, targetSeq?: number) => void;
  /** Extra HTTP handler (the MCP endpoint mounts here). Return true if handled. */
  readonly extraHttp?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

interface SocketState {
  readonly ws: WebSocket;
  readonly playerId: string | null;
}

/**
 * Local HTTP + WebSocket server: serves the single-file UI, streams redacted
 * events to spectators, full views to seated players, and feeds human actions
 * back through the ActionBus.
 */
export class TableWebServer {
  private readonly sockets = new Set<SocketState>();
  private readonly backlog: LoggedEvent[] = [];
  private readonly unsubscribe: () => void;

  private constructor(
    private readonly opts: TableWebOptions,
    private readonly http: Server,
    private readonly wss: WebSocketServer,
  ) {
    this.unsubscribe = opts.bus.onTurn((turn) => this.pushTurn(turn));
  }

  static async start(opts: TableWebOptions): Promise<TableWebServer> {
    const html = readFileSync(opts.indexHtmlPath, "utf8");
    const http = createServer((req, res) => {
      void (async () => {
        if (opts.extraHttp && (await opts.extraHttp(req, res))) return;
        if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    const wss = new WebSocketServer({ server: http, path: "/ws" });
    const server = new TableWebServer(opts, http, wss);
    wss.on("connection", (ws, req) => server.onConnection(ws, req));
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(opts.port, "127.0.0.1", () => resolve());
    });
    return server;
  }

  get port(): number {
    const address = this.http.address();
    return typeof address === "object" && address ? address.port : this.opts.port;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    const playerId = token ? (this.opts.seatTokens.get(token) ?? null) : null;
    const state: SocketState = { ws, playerId };
    this.sockets.add(state);
    ws.on("close", () => this.sockets.delete(state));
    ws.on("message", (data) => this.onMessage(state, data.toString()));

    const you = playerId
      ? this.opts.players.find((p) => p.playerId === playerId) ?? null
      : null;
    this.send(ws, {
      t: "hello",
      table: this.opts.table,
      you: you ? { playerId: you.playerId, name: you.name } : null,
      players: this.opts.players,
      chips: this.opts.chips,
      blinds: this.opts.blinds,
    });
    for (const event of this.backlog) {
      this.send(ws, { t: "event", ev: this.redact(event, playerId) });
    }
    if (playerId) {
      const pending = this.opts.bus.peek(playerId);
      if (pending) this.sendTurn(state, pending);
    }
  }

  private onMessage(state: SocketState, raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const playerId = state.playerId;
    if (!playerId) {
      this.send(state.ws, { t: "error", message: "spectators cannot act or chat" });
      return;
    }
    switch (message.t) {
      case "act": {
        const action = message.action as { kind?: unknown; amount?: unknown } | undefined;
        if (!action || typeof action.kind !== "string") {
          this.send(state.ws, { t: "error", message: "malformed action" });
          return;
        }
        const result = this.opts.bus.submit(playerId, {
          kind: action.kind,
          ...(typeof action.amount === "number" ? { amount: action.amount } : {}),
          ...(typeof message.say === "string" ? { say: message.say } : {}),
        });
        this.send(state.ws, result.ok ? { t: "act_ack" } : { t: "error", message: result.error });
        break;
      }
      case "chat": {
        if (!this.opts.chat.enabled || typeof message.text !== "string") return;
        const text = sanitizeSay(message.text, this.opts.chat.maxChars);
        if (text) this.opts.onChat(playerId, text);
        break;
      }
      case "react": {
        if (!this.opts.chat.reactions || typeof message.emoji !== "string") return;
        const emoji = sanitizeEmoji(message.emoji);
        if (emoji) {
          this.opts.onReact(
            playerId,
            emoji,
            typeof message.targetSeq === "number" ? message.targetSeq : undefined,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  /** Hole cards are private until the engine reveals them — redact per viewer. */
  private redact(event: LoggedEvent, viewerId: string | null): unknown {
    if (
      event.type === "engine_event" &&
      event.event.type === "hole-cards-dealt" &&
      event.event.playerId !== viewerId
    ) {
      return { ...event, event: { ...event.event, cards: null } };
    }
    return event;
  }

  broadcast(event: LoggedEvent): void {
    this.backlog.push(event);
    for (const state of this.sockets) {
      this.send(state.ws, { t: "event", ev: this.redact(event, state.playerId) });
    }
  }

  private pushTurn(turn: PendingTurn): void {
    for (const state of this.sockets) {
      if (state.playerId === turn.playerId) this.sendTurn(state, turn);
    }
  }

  private sendTurn(state: SocketState, turn: PendingTurn): void {
    this.send(state.ws, {
      t: "act_request",
      handNo: turn.view.handNo,
      deadlineAt: turn.deadlineAt,
      legal: turn.view.legal,
      view: turn.view,
    });
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const state of this.sockets) state.ws.close();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
