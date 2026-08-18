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
 * Keeps the route surface small and the client simple.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const op = typeof body.op === "string" ? body.op : "";
  const token = typeof body.token === "string" ? body.token : "";

  switch (op) {
    case "join": {
      const result = joinRoom(id, typeof body.name === "string" ? body.name : "");
      return result.ok
        ? NextResponse.json(result)
        : NextResponse.json({ error: result.error }, { status: 400 });
    }
    case "start": {
      const result = startRoom(id, token);
      return result.ok
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: result.error }, { status: 400 });
    }
    case "act": {
      const action = body.action as { kind?: unknown; amount?: unknown } | undefined;
      if (!action || typeof action.kind !== "string") {
        return NextResponse.json({ error: "malformed action" }, { status: 400 });
      }
      const result = actInRoom(
        id,
        token,
        {
          kind: action.kind,
          ...(typeof action.amount === "number" ? { amount: action.amount } : {}),
        },
        typeof body.say === "string" ? body.say : undefined,
      );
      return result.ok
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: result.error }, { status: 400 });
    }
    case "chat": {
      const result = chatInRoom(id, token, typeof body.text === "string" ? body.text : "");
      return result.ok
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: result.error }, { status: 400 });
    }
    case "react": {
      const result = reactInRoom(id, token, typeof body.emoji === "string" ? body.emoji : "");
      return result.ok
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: result.error }, { status: 400 });
    }
    case "rebuy": {
      const result = rebuyInRoom(id, token);
      return result.ok
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: result.error }, { status: 400 });
    }
    case "end": {
      const result = endRoom(id, token);
      return result.ok
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: result.error }, { status: 400 });
    }
    default:
      return NextResponse.json({ error: `unknown op "${op}"` }, { status: 400 });
  }
}
