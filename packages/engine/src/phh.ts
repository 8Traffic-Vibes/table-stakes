import { cardToString, type DomainEvent } from "@hivetech/poker-engine";

/**
 * PHH (.phh) hand-history export — the only formal machine-first spec
 * (uoftcprg/phh-std). One file per hand, TOML-derivative.
 *
 * Convention here: players are listed in blind order (p1 = small blind), which
 * is how blinds_or_straddles positions map to players in the spec.
 */

export interface PhhChatLine {
  /** Index into the produced actions array after which this remark was made. */
  readonly afterAction: number;
  readonly playerName: string;
  readonly text: string;
}

export interface HandRecord {
  readonly handNo: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Seat order as the engine sees it (rotated internally to blind order). */
  readonly players: ReadonlyArray<{
    readonly playerId: string;
    readonly name: string;
    readonly startingStack: number;
  }>;
  readonly events: readonly DomainEvent[];
  readonly chat?: readonly PhhChatLine[];
}

const esc = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export function handToPhh(rec: HandRecord): string {
  // Rotate players into blind order using the forced-bet events. Ring games:
  // p1 = small blind. Heads-up: phh-std reverse-assigns blinds, so a conformant
  // parser gives p1 the BIG blind — rotate so the big-blind poster is first.
  const headsUp = rec.players.length === 2;
  const anchorKind = headsUp ? "big-blind" : "small-blind";
  const anchorEvent = rec.events.find(
    (e) => e.type === "forced-bet-posted" && e.kind === anchorKind,
  );
  const anchorPlayerId =
    anchorEvent && anchorEvent.type === "forced-bet-posted"
      ? anchorEvent.playerId
      : rec.players[0]?.playerId;
  const anchorIndex = Math.max(
    0,
    rec.players.findIndex((p) => p.playerId === anchorPlayerId),
  );
  const ordered = [...rec.players.slice(anchorIndex), ...rec.players.slice(0, anchorIndex)];
  const pIndex = new Map(ordered.map((p, i) => [p.playerId, i + 1]));
  const label = (playerId: string): string => `p${pIndex.get(playerId) ?? 0}`;

  const blinds = ordered.map(() => 0);
  const antes = ordered.map(() => 0);
  for (const event of rec.events) {
    if (event.type !== "forced-bet-posted") continue;
    const idx = (pIndex.get(event.playerId) ?? 1) - 1;
    if (event.kind === "small-blind" || event.kind === "big-blind") {
      blinds[idx] = event.amount;
    } else {
      antes[idx] = event.amount;
    }
  }
  if (headsUp) {
    // phh-std heads-up: the file stores [sb, bb] and parsers reverse-assign,
    // so with p1 = big-blind poster the arrays must be written reversed.
    blinds.reverse();
    antes.reverse();
  }

  const actions: string[] = [];
  for (const event of rec.events) {
    switch (event.type) {
      case "hole-cards-dealt":
        actions.push(
          `d dh ${label(event.playerId)} ${event.cards.map(cardToString).join("")}`,
        );
        break;
      case "player-acted": {
        const who = label(event.playerId);
        const action = event.action;
        if (action.kind === "bet-to" || action.kind === "raise-to") {
          actions.push(`${who} cbr ${action.amount}`);
        } else if (action.kind === "fold") {
          actions.push(`${who} f`);
        } else {
          actions.push(`${who} cc`);
        }
        break;
      }
      case "street-dealt":
        actions.push(`d db ${event.cards.map(cardToString).join("")}`);
        break;
      case "cards-revealed":
        actions.push(
          `${label(event.playerId)} sm ${event.cards.map(cardToString).join("")}`,
        );
        break;
      default:
        break;
    }
  }

  // Attach table talk as PHH commentary on the action it followed.
  for (const line of rec.chat ?? []) {
    const idx = Math.min(Math.max(line.afterAction, 0), actions.length - 1);
    if (idx >= 0 && actions[idx] !== undefined) {
      actions[idx] = `${actions[idx]} # ${line.playerName}: ${line.text}`;
    }
  }

  const lines = [
    `variant = "NT"`,
    `antes = [${antes.join(", ")}]`,
    `blinds_or_straddles = [${blinds.join(", ")}]`,
    `min_bet = ${rec.bigBlind}`,
    `starting_stacks = [${ordered.map((p) => p.startingStack).join(", ")}]`,
    `actions = [`,
    ...actions.map((a) => `  "${esc(a)}",`),
    `]`,
    `hand = ${rec.handNo}`,
    `players = [${ordered.map((p) => `"${esc(p.name)}"`).join(", ")}]`,
    `currency = "TOK"`,
  ];
  return `${lines.join("\n")}\n`;
}
