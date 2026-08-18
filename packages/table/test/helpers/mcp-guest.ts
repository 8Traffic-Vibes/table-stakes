/**
 * Scripted MCP guest for E2E: connects to the table's /mcp endpoint, sits
 * down, and plays a passive check/call game until the session ends. Run:
 *   tsx packages/table/test/helpers/mcp-guest.ts <mcpUrl> <seatToken>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [, , mcpUrl, seatToken] = process.argv;
if (!mcpUrl || !seatToken) {
  console.error("usage: mcp-guest.ts <mcpUrl> <seatToken>");
  process.exit(2);
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Stateless server: fresh connection per call is fine and simplest.
  const client = new Client({ name: "mcp-guest", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl as string));
  // SDK transport types aren't exactOptionalPropertyTypes-clean.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  try {
    const result = await client.callTool({ name, arguments: { seatToken, ...args } });
    const content = (result.content as Array<{ type: string; text?: string }>)[0];
    return JSON.parse(content?.text ?? "{}") as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

const seat = await call("sit_down", {});
console.log("[guest] seated:", JSON.stringify(seat.you));

let saidHello = false;
for (let i = 0; i < 60; i += 1) {
  const turn = await call("wait_for_turn", { timeoutSeconds: 10 });
  if (!turn.turn) {
    continue;
  }
  const view = turn.view as { legal: Array<{ kind: string; amount?: number }>; street: string };
  const canCheck = view.legal.some((a) => a.kind === "check");
  const action = canCheck ? { kind: "check" } : { kind: "call" };
  const result = await call("act", {
    action,
    ...(saidHello ? {} : { say: "MCP guest, checking in. Literally." }),
    react: { emoji: "🤖" },
  });
  saidHello = true;
  console.log(`[guest] ${view.street}: ${action.kind} →`, JSON.stringify(result));
  if (result.error) break;
}
console.log("[guest] done");
process.exit(0);
