import { NextResponse } from "next/server";
import {
  actInRoom,
  chatInRoom,
  endRoom,
  joinRoom,
  reactInRoom,
  rebuyInRoom,
  startRoom,
} from "@/server/rooms";

export const dynamic = "force-dynamic";

/**
 * One action endpoint per room: {op: "join"|"start"|"act"|"chat"|"react"|"rebuy"|"end", ...}
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const op = typeof body.op === "string" ? body.op : "";
  const token = typeof body.token === "string" ? body.token : "";

  const respond = (result: Record<string, unknown>): NextResponse =>
    "error" in result
      ? NextResponse.json(result, { status: 400 })
      : NextResponse.json(result);

  try {
    switch (op) {
      case "join":
        return respond(await joinRoom(id, typeof body.name === "string" ? body.name : ""));
      case "start":
        return respond(await startRoom(id, token));
      case "act": {
        const action = body.action as { kind?: unknown; amount?: unknown } | undefined;
        if (!action || typeof action.kind !== "string") {
          return NextResponse.json({ error: "malformed action" }, { status: 400 });
        }
        return respond(
          await actInRoom(
            id,
            token,
            {
              kind: action.kind,
              ...(typeof action.amount === "number" ? { amount: action.amount } : {}),
            },
            typeof body.say === "string" ? body.say : undefined,
          ),
        );
      }
      case "chat":
        return respond(await chatInRoom(id, token, typeof body.text === "string" ? body.text : ""));
      case "react":
        return respond(await reactInRoom(id, token, typeof body.emoji === "string" ? body.emoji : ""));
      case "rebuy":
        return respond(await rebuyInRoom(id, token));
      case "end":
        return respond(await endRoom(id, token));
      default:
        return NextResponse.json({ error: `unknown op "${op}"` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "table hiccup — try again" },
      { status: 500 },
    );
  }
}
