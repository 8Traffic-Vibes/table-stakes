import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import {
  Ledger,
  OpenRouterClient,
  Vault,
  buildClaims,
  formatTokens,
  startRedemptionProxy,
  ClaimsStore,
  type Peg,
} from "@table-stakes/bank";
import { cardToString, verifyRunFile, type LoggedEvent } from "@table-stakes/engine";
import { loadConfig, runSession } from "@table-stakes/table";

function loadDotEnv(root: string): void {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] as string).replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function printer(names: Map<string, string>): (event: LoggedEvent) => void {
  const name = (playerId: string): string => names.get(playerId) ?? playerId;
  return (event) => {
    switch (event.type) {
      case "session_started": {
        console.log(pc.bold(`\n♠ table "${event.table}" opens`));
        for (const player of event.players) {
          names.set(player.playerId, player.name);
          console.log(`  ${player.name} ${pc.dim(`(${player.model ?? "?"})`)}`);
        }
        break;
      }
      case "buy_in":
        console.log(`  ${name(event.playerId)} buys in for ${pc.yellow(formatTokens(event.tokens))} tokens`);
        break;
      case "deck_committed":
        console.log(pc.dim(`  deck committed ${event.commit.slice(0, 16)}…`));
        break;
      case "engine_event": {
        const ev = event.event;
        if (ev.type === "hand-started") {
          console.log(pc.bold(`\n── hand ${ev.handNumber} ──`));
        } else if (ev.type === "forced-bet-posted") {
          console.log(pc.dim(`  ${name(ev.playerId)} posts ${ev.kind} ${ev.amount}`));
        } else if (ev.type === "hole-cards-dealt") {
          console.log(pc.dim(`  ${name(ev.playerId)}: ${ev.cards.map(cardToString).join(" ")}`));
        } else if (ev.type === "street-dealt") {
          console.log(pc.cyan(`  ${ev.street}: ${ev.cards.map(cardToString).join(" ")}`));
        } else if (ev.type === "cards-revealed") {
          console.log(
            `  ${name(ev.playerId)} shows ${ev.cards.map(cardToString).join(" ")} ${pc.dim(`(${ev.rank.category})`)}`,
          );
        } else if (ev.type === "pot-awarded") {
          for (const award of ev.awards) {
            console.log(pc.green(`  ${name(award.playerId)} wins ${formatTokens(award.amount)}`));
          }
        }
        break;
      }
      case "action_decided": {
        const action = event.action;
        let label: string;
        if (action.kind === "bet-to") label = `bets to ${formatTokens(action.amount)}`;
        else if (action.kind === "raise-to") label = `raises to ${formatTokens(action.amount)}`;
        else if (action.kind === "fold") label = "folds";
        else if (action.kind === "check") label = "checks";
        else label = "calls";
        const extras: string[] = [];
        if (event.inference) extras.push(`$${event.inference.costUsd.toFixed(5)}`);
        if (event.adjusted) extras.push(`adjusted: ${event.adjusted}`);
        if (event.fallback) extras.push(pc.red(`fallback: ${event.fallback}`));
        console.log(
          `  ${pc.bold(name(event.playerId))} ${label}${extras.length ? pc.dim(` [${extras.join(" · ")}]`) : ""}`,
        );
        break;
      }
      case "chat_said":
        console.log(pc.magenta(`  💬 ${name(event.playerId)}: “${event.text}”`));
        break;
      case "reaction_added":
        console.log(pc.magenta(`  ${event.emoji}  ${pc.dim(`from ${name(event.playerId)}`)}`));
        break;
      case "hand_settled": {
        const parts = Object.entries(event.deltasTokens).map(
          ([playerId, tokens]) =>
            `${name(playerId)} ${tokens > 0 ? pc.green(`+${formatTokens(tokens)}`) : pc.red(formatTokens(tokens))}`,
        );
        if (parts.length > 0) console.log(`  settled: ${parts.join(", ")}`);
        break;
      }
      case "session_ended":
        console.log(pc.bold(`\n♠ session over${event.aborted ? pc.red(` (ABORTED: ${event.aborted})`) : ""}`));
        break;
      default:
        break;
    }
  };
}

interface RunMeta {
  readonly peg: Peg;
  readonly nameOf: Map<string, string>;
}

function readRunMeta(runDir: string): RunMeta {
  const eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(eventsPath)) throw new Error(`no events.jsonl in ${runDir}`);
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "session_started") {
      const players = event.players as Array<{ playerId: string; name: string }>;
      return {
        peg: event.peg as Peg,
        nameOf: new Map(players.map((p) => [p.playerId, p.name])),
      };
    }
  }
  throw new Error(`no session_started event in ${eventsPath}`);
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value;
}

async function commandUp(values: {
  config: string;
  hands?: string | undefined;
  out?: string | undefined;
}): Promise<void> {
  const root = process.cwd();
  const apiKey = requireEnv(
    "OPENROUTER_API_KEY",
    "Copy .env.example to .env and add your key, or export it.",
  );
  const cfg = loadConfig(resolve(root, values.config));
  let config = cfg;
  if (values.hands !== undefined) {
    const hands = Number(values.hands);
    if (!Number.isInteger(hands) || hands <= 0) {
      throw new Error(`--hands must be a positive integer, got "${values.hands}"`);
    }
    config = { ...cfg, hands };
  }
  const outDir = resolve(root, values.out ?? join("runs", `${config.table}-${timestampSlug()}`));

  const client = new OpenRouterClient(apiKey, { title: "Table Stakes" });
  const names = new Map<string, string>();

  const result = await runSession(config, {
    client,
    outDir,
    onEvent: printer(names),
    onReady: (info) => {
      if (info.webUrl) {
        console.log(pc.bold(`\n  watch: ${pc.underline(info.webUrl)}`));
      }
      for (const seat of info.seatJoin) {
        if (seat.type === "human" && seat.url) {
          console.log(`  ${seat.name} plays at: ${pc.underline(seat.url)}`);
        } else if (seat.type === "mcp") {
          console.log(
            `  ${seat.name} (BYO agent): connect MCP to ${info.webUrl}/mcp with seat token ${pc.yellow(seat.token)}`,
          );
          console.log(
            pc.dim(
              `    e.g. claude mcp add --transport http table-stakes ${info.webUrl}/mcp — then sit_down with the token`,
            ),
          );
        }
      }
      console.log();
    },
  });

  console.log(`\nhands played: ${result.handsPlayed}`);
  console.log(`summary: ${result.summaryPath}`);
  console.log(`events:  ${join(result.outDir, "events.jsonl")}`);
  console.log(`ledger:  ${join(result.outDir, "ledger.jsonl")}`);
  console.log(`hands:   ${join(result.outDir, "hands")}/`);
  console.log(`verify:  pnpm demo verify --run ${result.outDir}`);
}

async function commandStake(values: {
  player?: string | undefined;
  vault?: string | undefined;
  "allow-limit-reset"?: boolean | undefined;
}): Promise<void> {
  const player = values.player;
  if (!player) throw new Error("--player <seat name> is required");
  const passphrase = requireEnv(
    "TABLE_STAKES_VAULT_PASSPHRASE",
    "The vault is encrypted; pick a passphrase and export it.",
  );
  const stakeKey = requireEnv(
    "STAKE_KEY",
    "Pass the OpenRouter key to stake via env: STAKE_KEY=sk-or-... pnpm demo stake --player <name>",
  );

  console.log("verifying stake key against OpenRouter…");
  const info = await new OpenRouterClient(stakeKey).keyInfo();
  const problems: string[] = [];
  if (info.limitUsd === null) problems.push("key has NO spend limit — stake caps are fiction");
  if (info.limitReset !== null && !values["allow-limit-reset"]) {
    problems.push(
      `key limit resets "${info.limitReset}" — the cap re-arms; pass --allow-limit-reset to accept`,
    );
  }
  if (info.byokUsageUsd > 0) {
    problems.push("key shows BYOK usage — metering would see only OpenRouter's 5% fee; refused");
  }
  if (problems.length > 0) {
    throw new Error(`stake key rejected:\n  - ${problems.join("\n  - ")}`);
  }
  const vaultPath = resolve(values.vault ?? ".table-stakes/vault.json");
  const vault = Vault.open(vaultPath, passphrase);
  vault.addKey(player, stakeKey, info.label);
  console.log(
    `staked for ${pc.bold(player)}: limit $${info.limitUsd}, remaining $${info.limitRemainingUsd ?? "?"} → ${vaultPath}`,
  );
}

async function commandRedeem(values: {
  run?: string | undefined;
  vault?: string | undefined;
  port?: string | undefined;
}): Promise<void> {
  const runDir = values.run;
  if (!runDir) throw new Error("--run <run directory> is required");
  const passphrase = requireEnv("TABLE_STAKES_VAULT_PASSPHRASE", "Needed to open the vault.");
  const { peg, nameOf } = readRunMeta(resolve(runDir));
  const ledger = Ledger.load(join(resolve(runDir), "ledger.jsonl"));
  const pairs = ledger.settlementPairs().map((pair) => ({
    from: nameOf.get(pair.from) ?? pair.from,
    to: nameOf.get(pair.to) ?? pair.to,
    tokens: pair.tokens,
  }));
  if (pairs.length === 0) {
    console.log("all square — nothing to redeem");
    return;
  }
  const vault = Vault.open(resolve(values.vault ?? ".table-stakes/vault.json"), passphrase);
  const missing = [...new Set(pairs.map((p) => p.from))].filter((name) => vault.getKey(name) === null);
  if (missing.length > 0) {
    throw new Error(
      `no staked key in the vault for: ${missing.join(", ")} — Tier 0 fallback: settle socially, or have them stake`,
    );
  }

  const claimsStore = new ClaimsStore(join(resolve(runDir), "claims.jsonl"));
  let claims = claimsStore.all();
  if (claims.length === 0) {
    claims = buildClaims(pairs, peg);
    claimsStore.create(claims);
  }
  const claimTokens = new Map<string, string>();
  console.log(pc.bold("claims:"));
  for (const claim of claims) {
    const token = randomBytes(8).toString("hex");
    claimTokens.set(token, claim.id);
    console.log(
      `  ${claim.to} ← ${claim.from}: ${formatTokens(claim.tokens)} tokens ($${claim.usdCap.toFixed(4)} cap, $${(claim.usdCap - claim.usdRedeemed).toFixed(4)} left) token=${pc.yellow(token)}`,
    );
  }

  const port = values.port ? Number(values.port) : 7799;
  const proxy = await startRedemptionProxy({ port, vault, claims: claimsStore, claimTokens });
  console.log(pc.bold(`\nredemption proxy: http://127.0.0.1:${proxy.port}/v1/chat/completions`));
  console.log(`  winners route their own OpenAI-compatible traffic through it:`);
  console.log(
    pc.dim(
      `  curl -sS http://127.0.0.1:${proxy.port}/v1/chat/completions -H "Authorization: Bearer <claim token>" \\\n    -H "Content-Type: application/json" -d '{"model":"deepseek/deepseek-chat-v3.1","messages":[{"role":"user","content":"hi"}],"max_tokens":50}'`,
    ),
  );
  console.log(pc.dim(`  claims status: http://127.0.0.1:${proxy.port}/claims — Ctrl+C to stop`));
  await new Promise<void>((resolveWait) => {
    process.once("SIGINT", () => {
      void proxy.close().then(() => resolveWait());
    });
  });
}

function commandVerify(values: { run?: string | undefined }): void {
  const runDir = values.run;
  if (!runDir) throw new Error("--run <run directory> is required");
  const report = verifyRunFile(join(resolve(runDir), "events.jsonl"));
  for (const hand of report.hands) {
    const mark = hand.ok ? pc.green("✓") : pc.red("✗");
    console.log(
      `${mark} hand ${hand.handNo}: commit ${hand.commitOk ? "ok" : "BAD"}, dealing ${hand.dealOk ? "ok" : "BAD"}, conservation ${hand.conservationOk ? "ok" : "BAD"}${hand.reasons.length ? ` — ${hand.reasons.join("; ")}` : ""}`,
    );
  }
  for (const reason of report.reasons) console.log(pc.red(`! ${reason}`));
  console.log(
    report.ok
      ? pc.green(`\nverified: ${report.handsChecked} hands — deck commitments, dealing, and conservation all check out`)
      : pc.red(`\nverification FAILED`),
  );
  if (!report.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: "table.config.json" },
      hands: { type: "string" },
      out: { type: "string" },
      run: { type: "string" },
      vault: { type: "string" },
      port: { type: "string" },
      player: { type: "string" },
      "allow-limit-reset": { type: "boolean" },
    },
  });
  loadDotEnv(process.cwd());
  const command = positionals[0] ?? "up";
  switch (command) {
    case "up":
      await commandUp(values);
      break;
    case "stake":
      await commandStake(values);
      break;
    case "redeem":
      await commandRedeem(values);
      break;
    case "verify":
      commandVerify(values);
      break;
    default:
      throw new Error(`unknown command "${command}" (up | stake | redeem | verify)`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
