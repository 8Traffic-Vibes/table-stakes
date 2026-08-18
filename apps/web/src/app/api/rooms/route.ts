import { NextResponse } from "next/server";
import { createRoom } from "@/server/rooms";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "pick a name" }, { status: 400 });
  }
  try {
    return NextResponse.json(createRoom(body.name));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not create room" },
      { status: 500 },
    );
  }
}
