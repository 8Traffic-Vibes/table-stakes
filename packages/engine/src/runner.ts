import {
  createTable,
  getLegalActions,
  projectTable,
  transition,
  replayCommands,
  type Card,
  type DomainEvent,
  type EngineError,
  type LegalAction,
  type PlayerAction,
  type TableCommand,
  type TableState,
  type TableView,
} from "@hivetech/poker-engine";

export class EngineCommandError extends Error {
  constructor(
    readonly engineError: EngineError,
    readonly command: TableCommand,
  ) {
    super(`${engineError.code}: ${engineError.message}`);
    this.name = "EngineCommandError";
  }
}

export interface RunnerConfig {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly minBuyIn: number;
  readonly maxBuyIn?: number;
  readonly maxSeats?: number;
}

/**
 * Thin stateful wrapper over the pure engine: applies commands, keeps the full
 * command log (so any final state is reproducible via replayCommands), and
 * exposes the queries the table loop needs.
 */
export class TableRunner {
  #state: TableState;
  readonly commands: TableCommand[] = [];

  constructor(readonly config: RunnerConfig) {
    this.#state = createTable({
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      minBuyIn: config.minBuyIn,
      ...(config.maxBuyIn !== undefined ? { maxBuyIn: config.maxBuyIn } : {}),
      ...(config.maxSeats !== undefined ? { maxSeats: config.maxSeats } : {}),
    });
  }

  get state(): TableState {
    return this.#state;
  }

  dispatch(command: TableCommand): readonly DomainEvent[] {
    const result = transition(this.#state, command);
    if (!result.ok) throw new EngineCommandError(result.error, command);
    this.#state = result.state;
    this.commands.push(command);
    return result.events;
  }

  seatPlayer(playerId: string, stack: number, seat?: number): readonly DomainEvent[] {
    return this.dispatch({
      type: "seat-player",
      playerId,
      stack,
      ...(seat !== undefined ? { seat } : {}),
    });
  }

  setSittingOut(playerId: string, sittingOut: boolean): readonly DomainEvent[] {
    return this.dispatch({ type: "set-sitting-out", playerId, sittingOut });
  }

  startHand(deck: readonly Card[]): readonly DomainEvent[] {
    return this.dispatch({ type: "start-hand", deck });
  }

  act(playerId: string, action: PlayerAction): readonly DomainEvent[] {
    return this.dispatch({ type: "act", playerId, action });
  }

  handActive(): boolean {
    return this.#state.hand !== null && this.#state.hand.stage !== "complete";
  }

  currentActorId(): string | null {
    const hand = this.#state.hand;
    if (!hand || hand.currentActorSeat === null) return null;
    const actor = hand.players.find((p) => p.seat === hand.currentActorSeat);
    return actor?.playerId ?? null;
  }

  legalFor(playerId: string): readonly LegalAction[] {
    return getLegalActions(this.#state, playerId);
  }

  playerView(playerId: string): TableView {
    return projectTable(this.#state, { kind: "player", playerId });
  }

  spectatorView(): TableView {
    return projectTable(this.#state, { kind: "spectator" });
  }

  /** Current stacks by playerId (seated players only). */
  stacks(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const seat of this.#state.seats) {
      if (seat) out[seat.playerId] = seat.stack;
    }
    return out;
  }

  /** Reproduce the current state purely from the command log; throws on divergence. */
  assertReplayable(): void {
    const replay = replayCommands(
      {
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        minBuyIn: this.config.minBuyIn,
        ...(this.config.maxBuyIn !== undefined ? { maxBuyIn: this.config.maxBuyIn } : {}),
        ...(this.config.maxSeats !== undefined ? { maxSeats: this.config.maxSeats } : {}),
      },
      this.commands,
    );
    if (!replay.ok) {
      throw new Error(
        `replay failed at command ${replay.commandIndex}: ${replay.error.code}`,
      );
    }
    if (JSON.stringify(replay.state) !== JSON.stringify(this.#state)) {
      throw new Error("replay diverged from live state");
    }
  }
}
