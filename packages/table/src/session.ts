import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EventLog,
  TableRunner,
  commitment,
  deriveDeck,
  handToPhh,
  newClientSeed,
  newServerSeed,
  cardToString,
  type Card,
  type DomainEvent,
  type LegalAction,
  type LoggedEvent,
  type PhhChatLine,
} from "@table-stakes/engine";
import {
  Ledger,
  freezePeg,
  formatTokens,
  tokensToChips,
  usdToTokens,
  type OpenRouterClient,
  type Peg,
} from "@table-stakes/bank";
import { ModelSeat } from "./seats/model.ts";
import { AcpSeat } from "./seats/acp.ts";
import { HumanSeat } from "./seats/human.ts";
import { ActionBus } from "./seats/bus.ts";
import {
  fallbackAction,
  type ActionEnvelope,
  type BanterEvent,
  type SeatDriver,
  type SeatView,
} from "./seats/driver.ts";
import { TableWebServer } from "./web/server.ts";
import { createMcpHttpHandler } from "./web/mcp.ts";
import { computeStats, formatStatsTable } from "./stats.ts";
import type { TableStakesConfig } from "./config.ts";

const PHH_ACTION_EVENTS = new Set<DomainEvent["type"]>([
  "hole-cards-dealt",
  "player-acted",
  "street-dealt",
  "cards-revealed",
]);

/** Guard against a stuck seat/engine interaction; ~4 players never need this many actions. */
const MAX_ACTIONS_PER_HAND = 500;

export interface SessionDeps {
  readonly client: OpenRouterClient;
  readonly outDir: string;
  readonly onEvent?: (event: LoggedEvent) => void;
  /** Called once seat tokens exist, before hand 1 — print join URLs here. */
  readonly onReady?: (info: {
    readonly webUrl: string | null;
    readonly seatJoin: ReadonlyArray<{ name: string; type: string; url: string | null; token: string }>;
  }) => void;
}

export interface SessionResult {
  readonly outDir: string;
  readonly peg: Peg;
  readonly handsPlayed: number;
  readonly finalStacks: Readonly<Record<string, number>>;
  readonly settlement: ReadonlyArray<{ from: string; to: string; tokens: number }>;
  readonly inferenceUsd: Readonly<Record<string, number>>;
  readonly summaryPath: string;
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function describeAction(name: string, event: DomainEvent): string | null {
  switch (event.type) {
    case "player-acted": {
      const action = event.action;
      if (action.kind === "bet-to") return `${name} bets to ${action.amount}`;
      if (action.kind === "raise-to") return `${name} raises to ${action.amount}`;
      if (action.kind === "fold") return `${name} folds`;
      if (action.kind === "check") return `${name} checks`;
      return `${name} calls ${event.paid}`;
    }
    case "street-dealt":
      return `${event.street}: ${event.cards.map(cardToString).join(" ")}`;
    default:
      return null;
  }
}

const WEB_INDEX_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "index.html");

export async function runSession(
  cfg: TableStakesConfig,
  deps: SessionDeps,
): Promise<SessionResult> {
  mkdirSync(join(deps.outDir, "hands"), { recursive: true });

  const peg = await freezePeg(deps.client, cfg.chips.referenceModel, cfg.chips.tokensPerChip);
  const keyInfo = await deps.client.keyInfo();

  const bus = new ActionBus({ maxChars: cfg.chat.maxChars });

  // --- seats ---
  const seats: SeatDriver[] = cfg.seats.map((seat, index) => {
    const playerId = `${slug(seat.name)}-${index + 1}`;
    const context = { playerId, name: seat.name };
    switch (seat.type) {
      case "model":
        return new ModelSeat({
          context,
          model: seat.model,
          client: deps.client,
          chat: { enabled: cfg.chat.enabled, maxChars: cfg.chat.maxChars },
          ...(seat.maxTokens !== undefined ? { maxTokens: seat.maxTokens } : {}),
        });
      case "acp":
        return new AcpSeat({
          context,
          ...(seat.agent !== undefined ? { agent: seat.agent } : {}),
          ...(seat.cmd !== undefined ? { cmd: seat.cmd } : {}),
          workspaceDir: join(deps.outDir, "workspaces", playerId),
          chat: { enabled: cfg.chat.enabled, maxChars: cfg.chat.maxChars },
        });
      case "human":
      case "mcp":
        return new HumanSeat(context, bus);
      default:
        throw new Error("unreachable seat type");
    }
  });
  const nameOf = new Map(seats.map((s) => [s.context.playerId, s.context.name]));
  const seatOf = new Map(seats.map((s) => [s.context.playerId, s]));
  const typeOf = new Map(seats.map((s, i) => [s.context.playerId, cfg.seats[i]?.type ?? "model"]));
  const modelOf = new Map(
    seats.map((s, i) => {
      const seatCfg = cfg.seats[i];
      return [s.context.playerId, seatCfg?.type === "model" ? seatCfg.model : seatCfg?.type ?? "?"];
    }),
  );

  // Seat tokens let humans (browser) and MCP guests claim their seats.
  const seatTokens = new Map<string, string>();
  for (const [i, seatCfg] of cfg.seats.entries()) {
    if (seatCfg.type === "human" || seatCfg.type === "mcp") {
      const playerId = seats[i]?.context.playerId;
      if (playerId) seatTokens.set(randomBytes(8).toString("hex"), playerId);
    }
  }

  const runner = new TableRunner({
    smallBlind: cfg.blinds.small,
    bigBlind: cfg.blinds.big,
    minBuyIn: cfg.buyIn.min,
    maxBuyIn: cfg.buyIn.max,
    maxSeats: cfg.seats.length,
  });

  // --- event plumbing (log → CLI printer + web broadcast) ---
  let web: TableWebServer | null = null;
  const log = new EventLog(join(deps.outDir, "events.jsonl"), (event) => {
    deps.onEvent?.(event);
    web?.broadcast(event);
  });
  const ledger = new Ledger(join(deps.outDir, "ledger.jsonl"));

  const chatHistory: Array<{ from: string; text: string }> = [];
  let currentHandNo: number | null = null;

  const recordChat = (playerId: string, text: string): void => {
    chatHistory.push({ from: nameOf.get(playerId) ?? playerId, text });
    log.append({ type: "chat_said", handNo: currentHandNo, playerId, text });
  };
  const recordReaction = (playerId: string, emoji: string, targetSeq?: number): void => {
    if (!cfg.chat.reactions) return;
    log.append({
      type: "reaction_added",
      handNo: currentHandNo,
      playerId,
      emoji,
      ...(targetSeq !== undefined ? { targetSeq } : {}),
    });
  };

  if (cfg.web.enabled) {
    web = await TableWebServer.start({
      port: cfg.web.port,
      indexHtmlPath: WEB_INDEX_PATH,
      table: cfg.table,
      players: seats.map((s) => ({
        playerId: s.context.playerId,
        name: s.context.name,
        seatType: typeOf.get(s.context.playerId) ?? "model",
      })),
      chips: cfg.chips,
      blinds: cfg.blinds,
      seatTokens,
      chat: { enabled: cfg.chat.enabled, maxChars: cfg.chat.maxChars, reactions: cfg.chat.reactions },
      bus,
      onChat: recordChat,
      onReact: recordReaction,
      extraHttp: createMcpHttpHandler({
        table: cfg.table,
        seatTokens,
        nameOf: (playerId) => nameOf.get(playerId) ?? playerId,
        bus,
        chat: { enabled: cfg.chat.enabled, maxChars: cfg.chat.maxChars, reactions: cfg.chat.reactions },
        onChat: recordChat,
        onReact: recordReaction,
        recentEvents: (viewerId, limit) =>
          log
            .events()
            .slice(-limit)
            .map((event) =>
              event.type === "engine_event" &&
              event.event.type === "hole-cards-dealt" &&
              event.event.playerId !== viewerId
                ? { ...event, event: { ...event.event, cards: null } }
                : event,
            ),
      }),
    });
  }

  const webUrl = web ? `http://127.0.0.1:${web.port}` : null;
  deps.onReady?.({
    webUrl,
    seatJoin: [...seatTokens.entries()].map(([token, playerId]) => ({
      name: nameOf.get(playerId) ?? playerId,
      type: typeOf.get(playerId) ?? "human",
      url: webUrl ? `${webUrl}/?token=${token}` : null,
      token,
    })),
  });

  log.append({
    type: "session_started",
    table: cfg.table,
    config: cfg,
    peg,
    keyLimitRemainingUsd: keyInfo.limitRemainingUsd,
    players: seats.map((s) => ({
      playerId: s.context.playerId,
      name: s.context.name,
      model: modelOf.get(s.context.playerId) ?? "?",
    })),
  });

  // Warm up agent subprocesses so npx cold-start doesn't eat the action clock.
  await Promise.all(
    seats.map(async (seat) => {
      try {
        await seat.start?.();
      } catch (error) {
        log.append({
          type: "chat_said",
          handNo: null,
          playerId: seat.context.playerId,
          text: `[table] seat failed to start: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }),
  );

  for (let i = 0; i < seats.length; i += 1) {
    const seat = seats[i];
    const seatCfg = cfg.seats[i];
    if (!seat || !seatCfg) continue;
    const buyIn = seatCfg.buyInTokens ?? cfg.buyIn.min;
    for (const event of runner.seatPlayer(seat.context.playerId, buyIn, i)) {
      log.append({ type: "engine_event", handNo: 0, event });
    }
    ledger.append({ kind: "buy_in", playerId: seat.context.playerId, tokens: buyIn });
    log.append({ type: "buy_in", playerId: seat.context.playerId, tokens: buyIn });
  }

  const clockMsFor = (playerId: string): number => {
    const type = typeOf.get(playerId);
    const seconds =
      type === "acp"
        ? cfg.clock.acpSeconds
        : type === "human"
          ? cfg.clock.humanSeconds
          : type === "mcp"
            ? cfg.clock.mcpSeconds
            : cfg.clock.modelSeconds;
    return Math.round(seconds * 1000);
  };

  let handsPlayed = 0;

  // Circuit breaker: an unreachable API must not quietly "play" the table into
  // a settlement no model ever decided.
  let consecutiveRequestFailures = 0;
  let apiDown = false;
  let abortReason: string | undefined;

  for (let handNo = 1; handNo <= cfg.hands; handNo += 1) {
    // Sit out busted players; stop when fewer than two can play.
    const stacks = runner.stacks();
    for (const [playerId, stack] of Object.entries(stacks)) {
      const seatState = runner.state.seats.find((s) => s?.playerId === playerId);
      if (stack <= 0 && seatState?.status === "active") {
        for (const event of runner.setSittingOut(playerId, true)) {
          log.append({ type: "engine_event", handNo: 0, event });
        }
      }
    }
    const playable = Object.entries(runner.stacks()).filter(([playerId, stack]) => {
      const seatState = runner.state.seats.find((s) => s?.playerId === playerId);
      return stack > 0 && seatState?.status === "active";
    });
    if (playable.length < 2) break;

    currentHandNo = handNo;

    // Commit–reveal, in protocol order: publish the commitment first, then the
    // (ordered) seed contributions, then derive. Model/agent seats can't choose
    // seeds yet, so the table draws them — recorded honestly as drawnBy: "table".
    const activeIds = playable.map(([playerId]) => playerId);
    const serverSeed = newServerSeed();
    log.append({ type: "deck_committed", handNo, commit: commitment(serverSeed) });
    const seeds = activeIds.map((playerId) => ({ playerId, seed: newClientSeed() }));
    log.append({ type: "seeds_collected", handNo, seeds, drawnBy: "table" });
    const deck: Card[] = deriveDeck({
      serverSeed,
      clientSeeds: seeds.map((s) => s.seed),
      nonce: handNo,
    });

    const stacksBefore = runner.stacks();
    const handEngineEvents: DomainEvent[] = [];
    const phhChat: PhhChatLine[] = [];
    const history: string[] = [];
    let phhActionCount = 0;
    const chatCount = new Map<string, number>();
    let street = "preflop";

    const recordEngineEvents = (events: readonly DomainEvent[]): void => {
      for (const event of events) {
        handEngineEvents.push(event);
        log.append({ type: "engine_event", handNo, event });
        if (PHH_ACTION_EVENTS.has(event.type)) phhActionCount += 1;
        if (event.type === "street-dealt") {
          street = event.street;
          chatCount.clear();
        }
        const line = describeAction(
          nameOf.get(("playerId" in event ? event.playerId : "") as string) ?? "?",
          event,
        );
        if (line) history.push(line);
      }
    };

    const inferenceUsdThisHand = new Map<string, number>();
    let actions = 0;
    try {
      recordEngineEvents(runner.startHand(deck));

      while (runner.handActive()) {
        if (actions >= MAX_ACTIONS_PER_HAND) {
          throw new Error(`hand ${handNo} exceeded ${MAX_ACTIONS_PER_HAND} actions`);
        }
        const playerId = runner.currentActorId();
        if (!playerId) break;
        const seat = seatOf.get(playerId);
        if (!seat) throw new Error(`no seat driver for ${playerId}`);
        const legal = runner.legalFor(playerId);
        const deadlineMs = clockMsFor(playerId);
        log.append({ type: "action_requested", handNo, playerId, legal, deadlineMs });

        let envelope: ActionEnvelope;
        if (apiDown) {
          envelope = { action: fallbackAction(legal), fallback: "session aborting: API unreachable" };
        } else {
          const view = buildSeatView({
            runner,
            playerId,
            handNo,
            street,
            blinds: cfg.blinds,
            nameOf,
            history,
            chat: chatHistory.slice(-12),
          });

          // Belt and braces: the seat gets deadlineMs via its own mechanism, and
          // the table races it anyway so a hung driver can never stall the hand.
          let clockTimer: NodeJS.Timeout | undefined;
          const seatPromise = seat.act(view, legal, deadlineMs);
          const tableClock = new Promise<ActionEnvelope>((resolve) => {
            clockTimer = setTimeout(
              () => resolve({ action: fallbackAction(legal), fallback: "table clock expired" }),
              deadlineMs + 2_000,
            );
          });
          envelope = await Promise.race([seatPromise, tableClock]);
          if (clockTimer) clearTimeout(clockTimer);
          if (envelope.fallback === "table clock expired") {
            // The hung driver may still resolve with real spend; ledger it late.
            void seatPromise
              .then((late) => {
                if (late.inference) {
                  ledger.append({
                    kind: "inference_spend",
                    handNo,
                    playerId,
                    usd: late.inference.costUsd,
                    ...(late.inference.generationId
                      ? { generationId: late.inference.generationId }
                      : {}),
                    note: "late",
                  });
                }
              })
              .catch(() => {});
          }
        }
        actions += 1;

        // Spend bookkeeping before the engine dispatch, so no code path below
        // can skip it. A failed request may still have been billed server-side.
        if (envelope.inference) {
          inferenceUsdThisHand.set(
            playerId,
            (inferenceUsdThisHand.get(playerId) ?? 0) + envelope.inference.costUsd,
          );
          ledger.append({
            kind: "inference_spend",
            handNo,
            playerId,
            usd: envelope.inference.costUsd,
            ...(envelope.inference.generationId
              ? { generationId: envelope.inference.generationId }
              : {}),
          });
          if (cfg.rules.thinkingBurnsStack && typeOf.get(playerId) === "model") {
            const burnTokens = Math.round(usdToTokens(envelope.inference.costUsd, peg));
            if (burnTokens > 0) {
              ledger.append({ kind: "burn", handNo, playerId, tokens: burnTokens });
            }
          }
        } else if (envelope.fallback && !apiDown && typeOf.get(playerId) === "model") {
          ledger.append({ kind: "inference_lost", handNo, playerId, reason: envelope.fallback });
        }

        if (envelope.fallback?.startsWith("request failed")) {
          consecutiveRequestFailures += 1;
          if (!apiDown && consecutiveRequestFailures >= seats.length * 2) {
            apiDown = true;
            abortReason = `OpenRouter unreachable: ${consecutiveRequestFailures} consecutive failed seat requests (last: ${envelope.fallback})`;
          }
        } else if (envelope.inference) {
          consecutiveRequestFailures = 0;
        }

        let applied = envelope.action;
        let appliedFallback = envelope.fallback;
        let engineEvents: readonly DomainEvent[];
        try {
          engineEvents = runner.act(playerId, envelope.action);
        } catch {
          applied = fallbackAction(legal);
          appliedFallback = `engine rejected ${JSON.stringify(envelope.action)}`;
          engineEvents = runner.act(playerId, applied);
        }

        log.append({
          type: "action_decided",
          handNo,
          playerId,
          action: applied,
          ...(envelope.adjusted ? { adjusted: envelope.adjusted } : {}),
          ...(appliedFallback ? { fallback: appliedFallback } : {}),
          ...(envelope.inference ? { inference: envelope.inference } : {}),
        });

        // Log talk before the engine events this action triggered, so a
        // call-quip reads before the street it bought — phhActionCount points
        // at the player-acted event about to be recorded.
        if (envelope.say && cfg.chat.enabled) {
          const key = `${street}:${playerId}`;
          const used = chatCount.get(key) ?? 0;
          if (used < cfg.chat.maxPerRound) {
            chatCount.set(key, used + 1);
            const name = nameOf.get(playerId) ?? playerId;
            chatHistory.push({ from: name, text: envelope.say });
            log.append({ type: "chat_said", handNo, playerId, text: envelope.say });
            phhChat.push({
              afterAction: phhActionCount,
              playerName: name,
              text: envelope.say,
            });
          }
        }
        if (envelope.react) {
          recordReaction(playerId, envelope.react.emoji, envelope.react.targetSeq);
        }
        recordEngineEvents(engineEvents);
      }
    } finally {
      // A committed hand must always reveal its seed, even when the hand loop
      // throws — an unrevealed commitment is an unverifiable orphan.
      log.append({
        type: "seed_revealed",
        handNo,
        serverSeed,
        deckCodes: deck.map(cardToString),
      });
    }

    const stacksAfter = runner.stacks();
    const deltas: Record<string, number> = {};
    for (const [playerId, before] of Object.entries(stacksBefore)) {
      const delta = (stacksAfter[playerId] ?? 0) - before;
      if (delta !== 0) {
        deltas[playerId] = delta;
        ledger.append({ kind: "hand_delta", handNo, playerId, tokens: delta });
      }
    }
    ledger.assertHandConservation(handNo);

    const inferenceUsd: Record<string, number> = {};
    for (const [playerId, usd] of inferenceUsdThisHand) inferenceUsd[playerId] = usd;
    log.append({ type: "hand_settled", handNo, deltasTokens: deltas, inferenceUsd });

    const participants = handEngineEvents.find((e) => e.type === "hand-started");
    const participantIds =
      participants?.type === "hand-started" ? participants.participantPlayerIds : activeIds;
    const phh = handToPhh({
      handNo,
      smallBlind: cfg.blinds.small,
      bigBlind: cfg.blinds.big,
      players: participantIds.map((playerId) => ({
        playerId,
        name: nameOf.get(playerId) ?? playerId,
        startingStack: stacksBefore[playerId] ?? 0,
      })),
      events: handEngineEvents,
      chat: phhChat,
    });
    writeFileSync(join(deps.outDir, "hands", `hand-${handNo}.phh`), phh, "utf8");

    // Banter prompts: showdowns are worth talking about. Each willing seat gets
    // one short, parallel chance to gloat or grumble.
    const completed = handEngineEvents.find((e) => e.type === "hand-completed");
    if (
      cfg.chat.enabled &&
      cfg.chat.banterPrompts === "showdown" &&
      completed?.type === "hand-completed" &&
      completed.reason === "showdown" &&
      !apiDown
    ) {
      const showdownLines = handEngineEvents
        .filter((e) => e.type === "cards-revealed" || e.type === "pot-awarded")
        .map((e) =>
          e.type === "cards-revealed"
            ? `${nameOf.get(e.playerId) ?? e.playerId} showed ${e.cards.map(cardToString).join(" ")} (${e.rank.category})`
            : e.awards
                .map((a) => `${nameOf.get(a.playerId) ?? a.playerId} won ${a.amount} tokens`)
                .join(", "),
        );
      const banterEvent: BanterEvent = {
        handNo,
        kind: "showdown",
        description: showdownLines.join("; "),
        chat: chatHistory.slice(-6),
      };
      await Promise.all(
        participantIds.map(async (playerId) => {
          const seat = seatOf.get(playerId);
          if (!seat?.banter) return;
          try {
            const banter = await seat.banter(banterEvent, 20_000);
            if (!banter) return;
            if (banter.say) recordChat(playerId, banter.say);
            if (banter.react) recordReaction(playerId, banter.react.emoji, banter.react.targetSeq);
          } catch {
            // banter is best-effort by design
          }
        }),
      );
    }

    currentHandNo = null;
    handsPlayed = handNo;
    if (apiDown) break;
  }

  runner.assertReplayable();

  const finalStacks = runner.stacks();
  const settlement = ledger.settlementPairs();
  const inferenceTotals = ledger.inferenceTotalsUsd();
  const inferenceUsd: Record<string, number> = {};
  for (const [playerId, usd] of inferenceTotals) inferenceUsd[playerId] = usd;
  const burns = ledger.burns();

  const summaryLines = [
    `# ${cfg.table} — session summary`,
    ``,
    `- peg: 1 chip = ${peg.tokensPerChip} tokens of ${peg.referenceModel} (${peg.usdPerToken.toExponential(3)} USD/token, frozen ${peg.frozenAt})`,
    `- hands played: ${handsPlayed}`,
    ...(abortReason
      ? [`- **SESSION ABORTED** — ${abortReason}. Hands after the abort were auto-folded, not played.`]
      : []),
    ``,
    `## Stacks (tokens)`,
    ``,
    ...Object.entries(finalStacks).map(([playerId, stack]) => {
      const name = nameOf.get(playerId) ?? playerId;
      const buyIn = ledger.buyIns().get(playerId) ?? 0;
      const burned = burns.get(playerId) ?? 0;
      const net = stack - buyIn - burned;
      const chips = tokensToChips(stack, peg).toFixed(1);
      return `- ${name}: ${formatTokens(stack)} (${chips} chips), net ${net >= 0 ? "+" : ""}${formatTokens(net)}${burned > 0 ? ` (incl. ${formatTokens(burned)} burned thinking)` : ""}`;
    }),
    ``,
    `## Settlement (Tier 0 — social ledger)`,
    ``,
    ...(settlement.length === 0
      ? ["- all square"]
      : settlement.map(
          (pair) =>
            `- ${nameOf.get(pair.from) ?? pair.from} owes ${nameOf.get(pair.to) ?? pair.to} ${formatTokens(pair.tokens)} tokens`,
        )),
    ``,
    `## Thinking cost (informational, actual OpenRouter spend)`,
    ``,
    ...Object.entries(inferenceUsd).map(
      ([playerId, usd]) => `- ${nameOf.get(playerId) ?? playerId}: $${usd.toFixed(6)}`,
    ),
    ``,
    `## Player stats`,
    ``,
    formatStatsTable(
      computeStats(log.events() as unknown as ReadonlyArray<Record<string, unknown>>),
      (playerId) => nameOf.get(playerId) ?? playerId,
    ),
    ``,
    `Seats: ${seats.map((s) => `${s.context.name} (${modelOf.get(s.context.playerId)})`).join(", ")}`,
    ``,
  ];
  const summaryPath = join(deps.outDir, "summary.md");
  writeFileSync(summaryPath, summaryLines.join("\n"), "utf8");

  ledger.append({ kind: "session_close" });
  log.append({
    type: "session_ended",
    finalStacks,
    summary: summaryLines.join("\n"),
    ...(abortReason ? { aborted: abortReason } : {}),
  });

  // Give the web UI a beat to show the ending, then tidy up.
  await Promise.all(
    seats.map((seat) => seat.leave?.("session over").catch(() => undefined)),
  );
  await web?.close();

  return {
    outDir: deps.outDir,
    peg,
    handsPlayed,
    finalStacks,
    settlement,
    inferenceUsd,
    summaryPath,
  };
}

function buildSeatView(args: {
  runner: TableRunner;
  playerId: string;
  handNo: number;
  street: string;
  blinds: { small: number; big: number };
  nameOf: Map<string, string>;
  history: readonly string[];
  chat: ReadonlyArray<{ from: string; text: string }>;
}): SeatView {
  const view = args.runner.playerView(args.playerId);
  const hand = view.hand;
  if (!hand) throw new Error("no active hand for seat view");
  const me = hand.players.find((p) => p.playerId === args.playerId);
  if (!me) throw new Error(`player ${args.playerId} not in hand`);

  const potTotal = hand.players.reduce((sum, p) => sum + p.committedHand, 0);
  const toCall = Math.max(0, hand.currentBet - me.committedStreet);
  const stacks: Record<string, number> = {};
  for (const seat of view.seats) {
    if (seat) stacks[args.nameOf.get(seat.playerId) ?? seat.playerId] = seat.stack;
  }
  const myStack = view.seats.find((s) => s?.playerId === args.playerId)?.stack ?? 0;

  const legal = args.runner.legalFor(args.playerId).map((a: LegalAction) => {
    if (a.kind === "call") return { kind: a.kind, amount: a.amount };
    if (a.kind === "bet-to" || a.kind === "raise-to") {
      return { kind: a.kind, min: a.minAmount, max: a.maxAmount };
    }
    return { kind: a.kind };
  });

  return {
    handNo: args.handNo,
    street: args.street,
    yourName: args.nameOf.get(args.playerId) ?? args.playerId,
    yourHoleCards: me.holeCards ? me.holeCards.map(cardToString) : [],
    board: hand.communityCards.map(cardToString),
    potTotal,
    toCall: Math.min(toCall, myStack),
    yourStack: myStack,
    blinds: args.blinds,
    stacks,
    legal,
    history: args.history,
    chat: args.chat,
  };
}
