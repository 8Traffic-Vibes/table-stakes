import type { LegalAction } from "@table-stakes/engine";
import type { ActionEnvelope, SeatContext, SeatDriver, SeatView } from "./driver.ts";
import type { ActionBus } from "./bus.ts";

/**
 * A human at the table. The web UI (or any surface holding the seat token)
 * submits the action through the ActionBus; the bus self-folds on the clock.
 * Humans banter whenever they like through the chat channel, so there is no
 * banter() here.
 */
export class HumanSeat implements SeatDriver {
  readonly context: SeatContext;

  constructor(context: SeatContext, private readonly bus: ActionBus) {
    this.context = context;
  }

  act(view: SeatView, legal: readonly LegalAction[], deadlineMs: number): Promise<ActionEnvelope> {
    return this.bus.request(this.context.playerId, view, legal, deadlineMs);
  }
}
