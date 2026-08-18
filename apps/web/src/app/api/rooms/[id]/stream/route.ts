import { advanceRoom, buildVM, dueAt, loadRoomDoc } from "@/server/rooms";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_MS = 1_200;

/**
 * SSE stream of personalized TableVM snapshots, store-poll based so ANY
 * instance can serve it: reload the room doc, push when it changed, and fire
 * due clocks (turn timeouts, next-hand deals) when nobody else has.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const token = new URL(req.url).searchParams.get("token");
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastV = -1;
      let lastBeat = Date.now();
      let stopped = false;

      const stop = (): void => {
        stopped = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
          let doc = await loadRoomDoc(id);
          if (!doc) {
            controller.enqueue(
              encoder.encode(`event: room_error\ndata: {"error":"room not found"}\n\n`),
            );
            stop();
            return;
          }
          const due = dueAt(doc);
          if (due !== null && due <= Date.now()) {
            await advanceRoom(id);
            doc = (await loadRoomDoc(id)) ?? doc;
          }
          if (doc.v !== lastV) {
            lastV = doc.v;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(buildVM(doc, token))}\n\n`));
            lastBeat = Date.now();
          } else if (Date.now() - lastBeat > 15_000) {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
            lastBeat = Date.now();
          }
        } catch {
          // transient store hiccup — next tick retries
        }
      };

      const timer = setInterval(() => void tick(), POLL_MS);
      void tick();
      req.signal.addEventListener("abort", stop);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
